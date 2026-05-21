import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { describePingSource, resolveRoutingTarget, runCli, writeWarning } from "../src/cli.js";
import { SETUP_TITLE } from "../src/setup.js";

function createContext(env = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
  stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
  return {
    context: { cwd: process.cwd(), env, stdin: new PassThrough(), stdout, stderr },
    output: () => ({ stdout: out, stderr: err }),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("prints top-level help", async () => {
  const { context, output } = createContext();
  const code = await runCli(["--help"], context);

  assert.equal(code, 0);
  assert.match(output().stdout, /doctor/);
  assert.match(output().stdout, /request get/);
});

test("clears local state with JSON output", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const { context, output } = createContext({ HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache") });
  const code = await runCli(["--json", "--clear"], context);

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output().stdout), { ok: true, cleared: true });
});

test("returns machine-readable errors under --json", async () => {
  const { context, output } = createContext();
  const code = await runCli(["--json", "unknown"], context);

  assert.equal(code, 1);
  assert.equal(JSON.parse(output().stdout).ok, false);
});

test("writes warning log lines with a yellow severity label", () => {
  const { context, output } = createContext({ FORCE_COLOR: "1" });

  writeWarning(context, "Could not deliver issue_comment delivery delivery-1 to Codex: no Codex session found.");

  assert.equal(output().stderr, "\u001b[33mwarning\u001b[0m Could not deliver issue_comment delivery delivery-1 to Codex: no Codex session found.\n");
});

test("returns from failed default tunnel startup instead of hanging", async () => {
  const { context, output } = createContext();
  const code = await runCli(["--json", "--port", "0"], {
    ...context,
    env: { ...context.env, PATH: "/path/without/ngrok" },
  });

  assert.equal(code, 1);
  assert.equal(JSON.parse(output().stdout).ok, false);
});

test("localhost foreground output is polished and Q quits immediately", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const { context, output } = createContext({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    NO_COLOR: "1",
  });
  context.stdin.isTTY = true;
  context.stdin.setRawMode = () => context.stdin;

  const run = runCli(["--localhost", "--port", "0"], context);
  await waitUntil(() => output().stdout.includes("[R] Reload webhooks"));
  context.stdin.write("Q");
  const code = await run;

  assert.equal(code, 0);
  assert.match(output().stdout, new RegExp(SETUP_TITLE.split("\n")[1] ?? "CODEX"));
  assert.match(output().stdout, /codex-github-router ready/);
  assert.doesNotMatch(output().stdout, /Press Ctrl-C to quit/);
  assert.doesNotMatch(output().stdout, /^> /m);
});

test("startup preflight runs before setup when existing config still requires setup", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const configHome = path.join(home, "config");
  const cacheHome = path.join(home, "cache");
  const configDir = path.join(home, "Library", "Application Support", "codex-github-router");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "config.json"), JSON.stringify({ version: 1, setupRequired: true }));
  const { context, output } = createContext({
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    NO_COLOR: "1",
  });

  const code = await runCli(["--port", "0"], {
    ...context,
    env: { ...context.env, PATH: "/path/without/ngrok" },
  });

  assert.equal(code, 1);
  assert.match(output().stdout, new RegExp(SETUP_TITLE.split("\n")[1] ?? "CODEX"));
  assert.match(output().stderr, /Preflight failed before changing GitHub webhooks/);
  assert.doesNotMatch(output().stdout, /Setup requires an interactive terminal/);
  assert.doesNotMatch(output().stdout, /codex-github-router ready/);
});

test("routes organization webhook deliveries through organization settings", () => {
  assert.deepEqual(
    resolveRoutingTarget({
      repositories: [{
        fullName: "patinaproject/codex-github-router",
        enabled: false,
        issueAutomationEnabled: false,
      }],
      organizations: [{
        login: "patinaproject",
        enabled: true,
      }],
    }, "patinaproject/codex-github-router"),
    { kind: "organization", name: "patinaproject" },
  );
});

test("repository webhook routing overrides organization settings when active", () => {
  assert.deepEqual(
    resolveRoutingTarget({
      repositories: [{
        fullName: "patinaproject/codex-github-router",
        enabled: true,
        issueAutomationEnabled: true,
      }],
      organizations: [{
        login: "patinaproject",
        enabled: true,
      }],
    }, "patinaproject/codex-github-router"),
    { kind: "repository", name: "patinaproject/codex-github-router" },
  );
});

test("issue automation alone does not route generic Codex inbox delivery", () => {
  assert.equal(
    resolveRoutingTarget({
      organizations: [{
        login: "patinaproject",
        enabled: false,
        issueAutomationEnabled: true,
      }],
    }, "patinaproject/codex-github-router"),
    null,
  );
});

test("describes organization webhook ping deliveries clearly", () => {
  assert.equal(
    describePingSource({
      organization: { login: "patinaproject" },
      hook: { type: "Organization" },
    }),
    "organization webhook patinaproject",
  );
});

test("describes repository webhook ping deliveries clearly", () => {
  assert.equal(
    describePingSource({
      repository: { full_name: "patinaproject/codex-github-router" },
      hook: { type: "Repository" },
    }),
    "repository webhook patinaproject/codex-github-router",
  );
});
