import assert from "node:assert/strict";
import test from "node:test";
import { syncGitHubWebhooks } from "../src/webhooks.js";
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
      if (args[0] === "/orgs/patinaproject/hooks") {
        return "[]";
      }
      return JSON.stringify({ id: 123, config: { url: "https://router.example.com/webhooks/github" } });
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 123, action: "created" }]);
  assert.equal(config.hasStoredSecrets, false);
  assert.equal(config.webhookSecret, undefined);
  assert.equal((config.organizations?.[0] as { hookId?: number }).hookId, 123);
  assert.deepEqual(calls[0], ["/orgs/patinaproject/hooks"]);
  assert.equal(calls[1]?.[0], "-X");
  assert.equal(calls[1]?.[1], "POST");
  assert.equal(calls[1]?.[2], "/orgs/patinaproject/hooks");
  assert.ok(calls[1]?.includes("config[url]=https://router.example.com/webhooks/github"));
  assert.ok(calls[1]?.includes("config[secret]=test-secret"));
});

test("updates existing repository and organization webhooks for the public URL", async () => {
  const calls: string[][] = [];
  const config: RouterConfig = {
    organizations: [{ login: "patinaproject", enabled: true, webhookSecret: "stored-secret" }],
    repositories: [{ fullName: "patinaproject/codex-github-router", enabled: true, webhookSecret: "stored-secret" }],
  };

  const result = await syncGitHubWebhooks({
    config,
    publicWebhookUrl: "https://router.example.com/webhooks/github",
    ghApi: async (args) => {
      calls.push(args);
      if (args[0] === "/orgs/patinaproject/hooks" || args[0] === "/repos/patinaproject/codex-github-router/hooks") {
        return JSON.stringify([{ id: 456, config: { url: "https://router.example.com/webhooks/github" } }]);
      }
      return JSON.stringify({ id: 456 });
    },
  });

  assert.deepEqual(result.organizations, [{ login: "patinaproject", hookId: 456, action: "updated" }]);
  assert.deepEqual(result.repositories, [{ fullName: "patinaproject/codex-github-router", hookId: 456, action: "updated" }]);
  assert.deepEqual(calls[1]?.slice(0, 3), ["-X", "PATCH", "/orgs/patinaproject/hooks/456"]);
  assert.deepEqual(calls[3]?.slice(0, 3), ["-X", "PATCH", "/repos/patinaproject/codex-github-router/hooks/456"]);
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

  assert.deepEqual(result, { repositories: [], organizations: [] });
  assert.deepEqual(calls, []);
});
