import assert from "node:assert/strict";
import test from "node:test";
import { cacheDir, configDir, sanitizeConfig } from "../src/config.js";

test("resolves macOS config and cache paths", () => {
  const context = { platform: "darwin", homedir: "/Users/alice", env: {} };
  assert.equal(configDir(context), "/Users/alice/Library/Application Support/codex-github-router");
  assert.equal(cacheDir(context), "/Users/alice/Library/Caches/codex-github-router");
});

test("resolves Linux config and cache paths using XDG env", () => {
  const context = {
    platform: "linux",
    homedir: "/home/alice",
    env: { XDG_CONFIG_HOME: "/tmp/config", XDG_CACHE_HOME: "/tmp/cache" },
  };
  assert.equal(configDir(context), "/tmp/config/codex-github-router");
  assert.equal(cacheDir(context), "/tmp/cache/codex-github-router");
});

test("resolves Windows config and cache paths", () => {
  const context = {
    platform: "win32",
    homedir: "C:\\Users\\alice",
    env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
  };
  assert.equal(configDir(context), "C:\\Users\\alice\\AppData\\Roaming/codex-github-router");
  assert.equal(cacheDir(context), "C:\\Users\\alice\\AppData\\Local/codex-github-router");
});

test("sanitizes settings without exposing secret fields", () => {
  assert.deepEqual(
    sanitizeConfig({
      version: 1,
      publicWebhookUrl: "https://user:secret@router.example.com/webhooks/github?token=never#print",
      localWebhookUrl: "http://127.0.0.1:3000/webhooks/github",
      setupRequired: true,
      mode: "tunnel",
      attachedToExistingTunnel: true,
      webhookSecret: "never-print",
      repositories: [{
        fullName: "patinaproject/codex-github-router",
        hookId: 123,
        webhookSecret: "never-print",
        issueAutomationLabel: "ready-for-agent",
        issueAutomationPrompt: "Implement with TDD.",
      }],
      organizations: [{
        login: "patinaproject",
        token: "never-print",
        issueAutomationLabel: "ready-for-codex",
        issueAutomationPrompt: "Open a draft PR.",
      }],
    }),
    {
      version: 1,
      publicWebhookUrl: "https://router.example.com/webhooks/github",
      localWebhookUrl: "http://127.0.0.1:3000/webhooks/github",
      setupRequired: true,
      mode: "tunnel",
      attachedToExistingTunnel: true,
      repositories: [{
        fullName: "patinaproject/codex-github-router",
        hookId: 123,
        issueAutomationLabel: "ready-for-agent",
        issueAutomationPrompt: "Implement with TDD.",
      }],
      organizations: [{
        login: "patinaproject",
        issueAutomationLabel: "ready-for-codex",
        issueAutomationPrompt: "Open a draft PR.",
      }],
      hasStoredSecrets: false,
    },
  );
});
