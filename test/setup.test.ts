import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runInteractiveSetup } from "../src/setup.js";
import type { SetupTarget } from "../src/setup.js";

type Cancelled = "cancelled";
type SettingsChoice = "repositories" | "organizations" | "finish";
type TargetChoice = string | "back";
type TargetSettingChoice = "toggle-enabled" | "toggle-issue-automation" | "back";

function createTestSetupPrompts({
  repositories = [],
  organizations = [],
  settings = ["finish"],
  targets = [],
  targetSettings = [],
  events,
}: {
  repositories?: SetupTarget[] | Cancelled;
  organizations?: SetupTarget[] | Cancelled;
  settings?: Array<SettingsChoice | Cancelled>;
  targets?: Array<TargetChoice | Cancelled>;
  targetSettings?: Array<TargetSettingChoice | Cancelled>;
  events: string[];
}) {
  const settingsQueue = [...settings];
  const targetQueue = [...targets];
  const targetSettingsQueue = [...targetSettings];
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
    async selectTarget({ title }: { title: string }) {
      const next = targetQueue.shift() ?? "back";
      events.push(`target:${title}:${next}`);
      return next;
    },
    async selectTargetSetting({ title }: { title: string }) {
      const next = targetSettingsQueue.shift() ?? "back";
      events.push(`target-setting:${title}:${next}`);
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
    settings: ["organizations", "repositories", "finish"],
    targets: ["owner", "back", "owner/one", "back"],
    targetSettings: ["toggle-issue-automation", "back", "toggle-enabled", "back"],
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
    repositories: [{ fullName: "owner/one", enabled: false, issueAutomationEnabled: false }],
    organizations: [{ login: "owner", enabled: true, issueAutomationEnabled: true }],
    setupRequired: false,
  });
  assert.deepEqual(events, [
    "intro:Interactive setup",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "select:organizations",
    "target:Organization-level settings:owner",
    "target-setting:owner:toggle-issue-automation",
    "target-setting:owner:back",
    "target:Organization-level settings:back",
    "select:repositories",
    "target:Repository-level settings:owner/one",
    "target-setting:owner/one:toggle-enabled",
    "target-setting:owner/one:back",
    "target:Repository-level settings:back",
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

test("interactive setup cancellation keeps setup required", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const events: string[] = [];
  const result = await runInteractiveSetup({
    context: {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      env: {},
    },
    discoverTargets: async () => ({
      repositories: [{ id: "owner/one", label: "owner/one" }],
      organizations: [{ id: "owner", label: "owner" }],
    }),
    prompts: createTestSetupPrompts({
      organizations: "cancelled",
      events,
    }),
  });

  assert.deepEqual(result, {
    repositories: [],
    organizations: [],
    setupRequired: true,
  });
  assert.deepEqual(events, [
    "intro:Interactive setup",
    "multiselect:Select organizations for organization webhooks",
    "cancel:Setup cancelled. Run codex-github-router again to finish setup.",
  ]);
});
