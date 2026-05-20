import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteGitHubWebhooks, syncGitHubWebhooks } from "../src/webhooks.js";
import type { RouterConfig } from "../src/types.js";

test("syncs organization webhooks through the organization hooks API", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true }],
    repositories: [],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    env: { CODEX_GITHUB_ROUTER_WEBHOOK_SECRET: "test-secret" },
    ghApi: async (args) => {
      calls.push(args);
      return JSON.stringify({ id: 123, config: { url: "https://router.example.com/webhooks/github" } });
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 123, action: "created" }]);
  assert.deepEqual(result.warnings, []);
  assert.equal(config.hasStoredSecrets, false);
  assert.equal(config.webhookSecret, undefined);
  assert.equal((config.organizations?.[0] as { hookId?: number }).hookId, 123);
  assert.equal(calls[0]?.[0], "-X");
  assert.equal(calls[0]?.[1], "POST");
  assert.equal(calls[0]?.[2], "/orgs/patinaproject/hooks");
  assert.ok(calls[0]?.includes("config[url]=https://router.example.com/webhooks/github"));
  assert.ok(calls[0]?.includes("config[secret]=test-secret"));
});

test("updates existing repository and organization webhooks by remembered hook ID", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true, hookId: 456 }],
    repositories: [{ fullName: "patinaproject/codex-github-router", enabled: true, hookId: 789 }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    ghApi: async (args) => {
      calls.push(args);
      return JSON.stringify({ id: args[2]?.endsWith("/789") ? 789 : 456 });
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 456, action: "updated" }]);
  assert.deepEqual(result.repositories, [{ fullName: "patinaproject/codex-github-router", hookId: 789, action: "updated" }]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls[0]?.slice(0, 3), ["-X", "PATCH", "/orgs/patinaproject/hooks/456"]);
  assert.deepEqual(calls[1]?.slice(0, 3), ["-X", "PATCH", "/repos/patinaproject/codex-github-router/hooks/789"]);
});

test("stores one generated router secret when no env secret is provided", async () => {
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true }],
    repositories: [{ fullName: "patinaproject/codex-github-router", enabled: true }],
  };
  const usedSecrets: string[] = [];

  await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    ghApi: async (args) => {
      const secretField = args.find((arg) => arg.startsWith("config[secret]="));
      if (secretField) {
        usedSecrets.push(secretField);
        return JSON.stringify({ id: usedSecrets.length });
      }
      return "[]";
    },
  });

  assert.equal(config.hasStoredSecrets, true);
  assert.equal(typeof config.webhookSecret, "string");
  assert.equal(usedSecrets.length, 2);
  assert.equal(usedSecrets[0], usedSecrets[1]);
});

test("reload mode warns instead of creating targets without hook IDs", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true }],
    repositories: [{ fullName: "patinaproject/codex-github-router", enabled: true }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    createMissing: false,
    ghApi: async (args) => {
      calls.push(args);
      return "{}";
    },
  });

  assert.deepEqual(result.organizations, []);
  assert.deepEqual(result.repositories, []);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["hook_id_missing", "hook_id_missing"]);
  assert.deepEqual(calls, []);
});

test("reload mode warns instead of recreating missing remembered hooks", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true, hookId: 456 }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    createMissing: false,
    ghApi: async (args) => {
      calls.push(args);
      throw new Error("404 Not Found");
    },
  });

  assert.deepEqual(result.organizations, []);
  assert.deepEqual(result.warnings, [{
    target: "patinaproject",
    code: "hook_missing",
    message: "Remembered GitHub webhook 456 for patinaproject no longer exists.",
  }]);
  assert.deepEqual(calls[0]?.slice(0, 3), ["-X", "PATCH", "/orgs/patinaproject/hooks/456"]);
});

test("startup sync recreates missing remembered hooks and stores the new hook ID", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true, hookId: 456 }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    ghApi: async (args) => {
      calls.push(args);
      if (args[1] === "PATCH") {
        throw new Error("404 Not Found");
      }
      return JSON.stringify({ id: 789 });
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 789, action: "created" }]);
  assert.equal((config.organizations?.[0] as { hookId?: number }).hookId, 789);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["-X", "PATCH", "/orgs/patinaproject/hooks/456"],
    ["-X", "POST", "/orgs/patinaproject/hooks"],
  ]);
});

test("skips disabled webhook targets", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: false }],
    repositories: [{ fullName: "patinaproject/codex-github-router", enabled: false }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    ghApi: async (args) => {
      calls.push(args);
      return "[]";
    },
  });

  assert.deepEqual(result, { repositories: [], organizations: [], warnings: [] });
  assert.deepEqual(calls, []);
});

test("syncing an organization-covered repository does not create a repo hook when disabled", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true }],
    repositories: [{ fullName: "patinaproject/using-github", enabled: false }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    env: { CODEX_GITHUB_ROUTER_WEBHOOK_SECRET: "test-secret" },
    ghApi: async (args) => {
      calls.push(args);
      return JSON.stringify({ id: 123 });
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 123, action: "created" }]);
  assert.deepEqual(result.repositories, []);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["-X", "POST", "/orgs/patinaproject/hooks"],
  ]);
});

test("deletes remembered repository and organization webhooks by hook ID", async () => {
  const calls: string[][] = [];
  const result = await deleteGitHubWebhooks({
    config: {
      organizations: [{ login: "patinaproject", hookId: 123 }],
      repositories: [{ fullName: "patinaproject/codex-github-router", hookId: 456 }],
    },
    ghApi: async (args) => {
      calls.push(args);
      return "";
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 123, action: "deleted" }]);
  assert.deepEqual(result.repositories, [{ fullName: "patinaproject/codex-github-router", hookId: 456, action: "deleted" }]);
  assert.deepEqual(calls, [
    ["-X", "DELETE", "/orgs/patinaproject/hooks/123"],
    ["-X", "DELETE", "/repos/patinaproject/codex-github-router/hooks/456"],
  ]);
});

test("treats already-missing remembered webhooks as deleted during cleanup", async () => {
  const result = await deleteGitHubWebhooks({
    config: {
      organizations: [{ login: "patinaproject", hookId: 123 }],
    },
    ghApi: async () => {
      throw new Error("404 Not Found");
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 123, action: "already_missing" }]);
});

test("propagates webhook deletion failures so local config can be preserved", async () => {
  await assert.rejects(
    deleteGitHubWebhooks({
      config: {
        organizations: [{ login: "patinaproject", hookId: 123 }],
      },
      ghApi: async () => {
        throw new Error("permission denied");
      },
    }),
    /permission denied/,
  );
});

test("sanitizes org webhook scope failures without printing secrets", async () => {
  const originalPath = process.env.PATH;
  const binDir = await mkdtemp(path.join(os.tmpdir(), "router-gh-"));
  const ghPath = path.join(binDir, "gh");
  await writeFile(ghPath, [
    "#!/bin/sh",
    "echo 'gh: Not Found (HTTP 404)' >&2",
    "echo 'gh: This API operation needs the \"admin:org_hook\" scope. To request it, run:  gh auth refresh -h github.com -s admin:org_hook' >&2",
    "exit 1",
    "",
  ].join("\n"));
  await chmod(ghPath, 0o755);
  process.env.PATH = binDir;
  try {
    await assert.rejects(
      syncGitHubWebhooks({
        config: {
          organizations: [{ login: "patinaproject", enabled: true }],
        },
        publicWebhookUrl: "https://router.example.com/webhooks/github",
        env: { CODEX_GITHUB_ROUTER_WEBHOOK_SECRET: "super-secret-value" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /admin:org_hook/);
        assert.match(error.message, /gh auth refresh -h github\.com -s admin:org_hook/);
        assert.doesNotMatch(error.message, /super-secret-value/);
        assert.doesNotMatch(error.message, /config\[secret\]/);
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
