import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runInteractiveSetup } from "../src/setup.js";
import type { SetupTarget } from "../src/setup.js";

type Cancelled = "cancelled";
type SettingsChoice = "repositories" | "organizations" | "finish";

function createTestSetupPrompts({
  repositories = [],
  organizations = [],
  settings = ["finish"],
  events,
}: {
  repositories?: SetupTarget[] | Cancelled;
  organizations?: SetupTarget[] | Cancelled;
  settings?: Array<SettingsChoice | Cancelled>;
  events: string[];
}) {
  const settingsQueue = [...settings];
  return {
    intro(message: string) {
      events.push(`intro:${message}`);
    },
    async multiselectTargets({ message }: { message: string }) {
      events.push(`multiselect:${message}`);
      return message.includes("repositories") ? repositories : organizations;
    },
    async selectSettings() {
      const next = settingsQueue.shift() ?? "finish";
      events.push(`select:${next}`);
      return next;
    },
    note({ title, message }: { title: string; message: string }) {
      events.push(`note:${title}:${message}`);
    },
    outro(message: string) {
      events.push(`outro:${message}`);
    },
    cancel(message: string) {
      events.push(`cancel:${message}`);
    },
  };
}

test("interactive setup selects repositories and organizations with Clack prompts", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const events: string[] = [];
  const prompts = createTestSetupPrompts({
    repositories: [{ id: "owner/one", label: "owner/one" }],
    organizations: [{ id: "owner", label: "owner" }],
    settings: ["repositories", "organizations", "finish"],
    events,
  });

  const result = await runInteractiveSetup({
    context: {
      stdin,
      stdout,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
    },
    discoverTargets: async () => ({
      repositories: [
        { id: "owner/one", label: "owner/one" },
        { id: "owner/two", label: "owner/two" },
      ],
      organizations: [{ id: "owner", label: "owner" }],
    }),
    prompts,
  });

  assert.deepEqual(result, {
    repositories: [{ fullName: "owner/one", enabled: true, issueAutomationEnabled: false }],
    organizations: [{ login: "owner", enabled: true, issueAutomationEnabled: false }],
    setupRequired: false,
  });
  assert.deepEqual(events, [
    "intro:codex-github-router setup",
    "multiselect:Select repositories for repository webhooks",
    "multiselect:Select organizations for organization webhooks",
    "select:repositories",
    "note:Repository-level settings:Defaults: webhooks enabled, issue automation off, label ready-for-agent.\n- owner/one",
    "select:organizations",
    "note:Organization-level settings:Defaults: webhooks enabled, issue automation off, label ready-for-agent.\n- owner",
    "select:finish",
    "outro:Setup saved. Starting router...",
  ]);
});

test("interactive setup reports non-TTY setup requirement", async () => {
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const result = await runInteractiveSetup({
    context: {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      env: {},
    },
  });

  assert.equal(result.setupRequired, true);
  assert.match(output, /interactive terminal/);
});
