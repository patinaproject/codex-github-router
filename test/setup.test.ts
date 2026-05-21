import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { discoverGitHubTargets, runInteractiveSetup } from "../src/setup.js";
import type { SetupTarget } from "../src/setup.js";

type Cancelled = "cancelled";
type SettingsChoice = "repositories" | "organizations" | "finish";
type TargetChoice = string | "back";
type TargetSettingChoice = "toggle-enabled" | "toggle-issue-automation" | "set-issue-label" | "set-issue-prompt" | "back";

function createTestSetupPrompts({
  repositories = [],
  organizations = [],
  repositorySelections,
  organizationSelections,
  settings = ["finish"],
  targets = [],
  targetSettings = [],
  textValues = [],
  events,
}: {
  repositories?: SetupTarget[] | Cancelled;
  organizations?: SetupTarget[] | Cancelled;
  repositorySelections?: Array<SetupTarget[] | Cancelled>;
  organizationSelections?: Array<SetupTarget[] | Cancelled>;
  settings?: Array<SettingsChoice | Cancelled>;
  targets?: Array<TargetChoice | Cancelled>;
  targetSettings?: Array<TargetSettingChoice | Cancelled>;
  textValues?: Array<string | Cancelled>;
  events: string[];
}) {
  const settingsQueue = [...settings];
  const targetQueue = [...targets];
  const targetSettingsQueue = [...targetSettings];
  const textQueue = [...textValues];
  const repositorySelectionQueue = repositorySelections ? [...repositorySelections] : null;
  const organizationSelectionQueue = organizationSelections ? [...organizationSelections] : null;
  return {
    intro(message: string) {
      events.push(`intro:${message}`);
    },
    async multiselectTargets({ message }: { message: string }) {
      events.push(`multiselect:${message}`);
      if (message.includes("repositories")) {
        return repositorySelectionQueue?.shift() ?? repositories;
      }
      return organizationSelectionQueue?.shift() ?? organizations;
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
    async text({ message, initialValue }: { message: string; initialValue: string }) {
      const next = textQueue.shift() ?? initialValue;
      events.push(`text:${message}:${initialValue}:${next}`);
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
    repositories: [],
    organizations: [{ id: "owner", label: "owner" }],
    settings: ["organizations", "repositories", "finish"],
    targets: ["owner", "back", "owner/one", "back"],
    targetSettings: ["toggle-issue-automation", "set-issue-label", "set-issue-prompt", "back", "toggle-enabled", "back"],
    textValues: ["ready-for-codex", "Use TDD and open a draft PR."],
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
      repositories: [],
      organizations: [{ id: "owner", label: "owner" }],
    }),
    discoverRepositoriesForOrganizations: async () => [
      { id: "owner/one", label: "owner/one" },
      { id: "owner/two", label: "owner/two" },
    ],
    prompts,
  });

  assert.deepEqual(result, {
    repositories: [
      {
        fullName: "owner/one",
        enabled: true,
        issueAutomationEnabled: false,
        issueAutomationLabel: "ready-for-agent",
        issueAutomationPrompt: "Develop this issue using TDD, open a pull request, and report verification steps.",
      },
      {
        fullName: "owner/two",
        enabled: false,
        issueAutomationEnabled: false,
        issueAutomationLabel: "ready-for-agent",
        issueAutomationPrompt: "Develop this issue using TDD, open a pull request, and report verification steps.",
      },
    ],
    organizations: [{
      login: "owner",
      enabled: true,
      issueAutomationEnabled: true,
      issueAutomationLabel: "ready-for-codex",
      issueAutomationPrompt: "Use TDD and open a draft PR.",
    }],
    setupRequired: false,
  });
  assert.deepEqual(events, [
    "intro:Welcome to the night shift",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "select:organizations",
    "target:Organization-level settings:owner",
    "target-setting:owner:toggle-issue-automation",
    "target-setting:owner:set-issue-label",
    "text:Issue automation label:ready-for-agent:ready-for-codex",
    "target-setting:owner:set-issue-prompt",
    "text:Issue automation prompt:Develop this issue using TDD, open a pull request, and report verification steps.:Use TDD and open a draft PR.",
    "target-setting:owner:back",
    "target:Organization-level settings:back",
    "select:repositories",
    "target:Repository-level settings:owner/one",
    "target-setting:owner/one:toggle-enabled",
    "target-setting:owner/one:back",
    "target:Repository-level settings:back",
    "select:finish",
    "outro:Setup saved. Commencing simulation...",
  ]);
});

test("discovers all authenticated organizations with gh pagination", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const targets = await discoverGitHubTargets(async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "repo") {
      return { stdout: JSON.stringify([]), stderr: "" };
    }
    return {
      stdout: JSON.stringify([
        [{ login: "owner-a" }],
        [{ login: "owner-b" }],
      ]),
      stderr: "",
    };
  });

  assert.deepEqual(targets.organizations, [
    { id: "owner-a", label: "owner-a" },
    { id: "owner-b", label: "owner-b" },
  ]);
  assert.deepEqual(calls.find((call) => call.args[0] === "api")?.args, ["api", "--paginate", "--slurp", "user/orgs"]);
});

test("organization-covered repositories do not create repository webhooks by default", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const events: string[] = [];
  const result = await runInteractiveSetup({
    context: {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
    },
    discoverTargets: async () => ({
      repositories: [],
      organizations: [{ id: "owner", label: "owner" }],
    }),
    discoverRepositoriesForOrganizations: async () => [
      { id: "owner/one", label: "owner/one" },
      { id: "owner/two", label: "owner/two" },
    ],
    prompts: createTestSetupPrompts({
      organizations: [{ id: "owner", label: "owner" }],
      repositories: [],
      settings: ["finish"],
      events,
    }),
  });

  assert.deepEqual(result.repositories.map((repository) => ({
    fullName: repository.fullName,
    enabled: repository.enabled,
  })), [
    { fullName: "owner/one", enabled: false },
    { fullName: "owner/two", enabled: false },
  ]);
  assert.deepEqual(events, [
    "intro:Welcome to the night shift",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "select:finish",
    "outro:Setup saved. Commencing simulation...",
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
    "intro:Welcome to the night shift",
    "multiselect:Select organizations for organization webhooks",
    "cancel:Setup cancelled. Run codex-github-router again to finish setup.",
  ]);
});

test("settings cancellation navigates back instead of cancelling setup", async () => {
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
      repositories: [],
      organizations: [{ id: "owner", label: "owner" }],
    }),
    discoverRepositoriesForOrganizations: async () => [{ id: "owner/one", label: "owner/one" }],
    prompts: createTestSetupPrompts({
      organizations: [{ id: "owner", label: "owner" }],
      repositories: [],
      settings: ["organizations", "finish"],
      targets: ["owner"],
      targetSettings: ["set-issue-prompt", "cancelled", "cancelled"],
      textValues: ["cancelled"],
      events,
    }),
  });

  assert.equal(result.setupRequired, false);
  assert.equal(result.organizations[0]?.issueAutomationPrompt, "Develop this issue using TDD, open a pull request, and report verification steps.");
  assert.deepEqual(events, [
    "intro:Welcome to the night shift",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "select:organizations",
    "target:Organization-level settings:owner",
    "target-setting:owner:set-issue-prompt",
    "text:Issue automation prompt:Develop this issue using TDD, open a pull request, and report verification steps.:cancelled",
    "target-setting:owner:cancelled",
    "target:Organization-level settings:back",
    "select:finish",
    "outro:Setup saved. Commencing simulation...",
  ]);
});

test("repository selection cancellation goes back to organization selection", async () => {
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
    discoverRepositoriesForOrganizations: async () => [],
    prompts: createTestSetupPrompts({
      organizationSelections: [[{ id: "owner", label: "owner" }], []],
      repositorySelections: ["cancelled", []],
      settings: ["finish"],
      events,
    }),
  });

  assert.equal(result.setupRequired, false);
  assert.deepEqual(result.organizations, []);
  assert.deepEqual(events, [
    "intro:Welcome to the night shift",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "select:finish",
    "outro:Setup saved. Commencing simulation...",
  ]);
});

test("settings menu cancellation goes back to repository selection", async () => {
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
    discoverRepositoriesForOrganizations: async () => [],
    prompts: createTestSetupPrompts({
      organizations: [{ id: "owner", label: "owner" }],
      repositorySelections: [[{ id: "owner/one", label: "owner/one" }], []],
      settings: ["cancelled", "finish"],
      events,
    }),
  });

  assert.equal(result.setupRequired, false);
  assert.deepEqual(result.repositories.map((repository) => repository.fullName), ["owner/one"]);
  assert.deepEqual(events, [
    "intro:Welcome to the night shift",
    "multiselect:Select organizations for organization webhooks",
    "multiselect:Select repositories for repository webhooks",
    "select:cancelled",
    "multiselect:Select repositories for repository webhooks",
    "select:finish",
    "outro:Setup saved. Commencing simulation...",
  ]);
});
