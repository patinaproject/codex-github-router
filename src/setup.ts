import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cancel, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import type { RuntimeContext } from "./types.js";

const execFileAsync = promisify(execFile);
const CANCELLED = "cancelled";
const DEFAULT_ISSUE_AUTOMATION_LABEL = "ready-for-agent";
const DEFAULT_ISSUE_AUTOMATION_PROMPT = "Develop this issue using TDD, open a pull request, and report verification steps.";
export const SETUP_TITLE = String.raw`
C Y B E R P U N K   G I T H U B    R O U T I N G   C O N S O L E

   _____  _____  ____  _____  __  __        _____  __  _____  __  __  __  __  ____
  / ___/ / __  / / __ \ / ___/ \ \/ /       / ___/ / / /_  _/ / / / / \ \/ / / __ \
 / /__  / /_/ / / /_/ / /__    \  /  _____ / /__  / /   / /  / /_/ /   \  / / /_/ /
 \___/  \____/  \____/ \___/   /_/\_\_____\\___/ /_/   /_/   \____/   /_/\_\ \____/

        C O D E X - G I T H U B - R O U T E R
`;

export interface SetupTarget {
  id: string;
  label: string;
}

export interface SetupSelection {
  repositories: Array<{ fullName: string; enabled: boolean; issueAutomationEnabled: boolean; issueAutomationLabel: string; issueAutomationPrompt: string }>;
  organizations: Array<{ login: string; enabled: boolean; issueAutomationEnabled: boolean; issueAutomationLabel: string; issueAutomationPrompt: string }>;
  setupRequired: boolean;
}

export interface SetupTargets {
  repositories: SetupTarget[];
  organizations: SetupTarget[];
}

type SetupContext = Pick<RuntimeContext, "stdin" | "stdout" | "stderr" | "env">;
type Cancelled = typeof CANCELLED;
type SettingsChoice = "organizations" | "repositories" | "finish";
type TargetChoice = string | "back";
type TargetSettingChoice = "toggle-enabled" | "toggle-issue-automation" | "set-issue-label" | "set-issue-prompt" | "back";
type ConfiguredTarget = SetupTarget & { enabled: boolean; issueAutomationEnabled: boolean; issueAutomationLabel: string; issueAutomationPrompt: string };

interface SetupPromptAdapter {
  intro(message: string, context: SetupContext): void;
  multiselectTargets(args: { message: string; items: SetupTarget[]; context: SetupContext }): Promise<SetupTarget[] | Cancelled>;
  selectSettings(args: { context: SetupContext; finishLabel: string }): Promise<SettingsChoice | Cancelled>;
  selectTarget(args: { title: string; targets: ConfiguredTarget[]; context: SetupContext }): Promise<TargetChoice | Cancelled>;
  selectTargetSetting(args: { title: string; target: ConfiguredTarget; context: SetupContext }): Promise<TargetSettingChoice | Cancelled>;
  text(args: { message: string; initialValue: string; context: SetupContext }): Promise<string | Cancelled>;
  note(args: { title: string; message: string; context: SetupContext }): void;
  outro(message: string, context: SetupContext): void;
  cancel(message: string, context: SetupContext): void;
}

export async function discoverGitHubTargets(): Promise<SetupTargets> {
  const [repos, orgs] = await Promise.all([
    execFileAsync("gh", ["repo", "list", "--limit", "100", "--json", "nameWithOwner"], { timeout: 15000 }),
    execFileAsync("gh", ["api", "user/orgs"], { timeout: 15000 }),
  ]);

  const parsedRepos = JSON.parse(repos.stdout) as Array<{ nameWithOwner?: string }>;
  const parsedOrgs = JSON.parse(orgs.stdout) as Array<{ login?: string }>;

  return {
    repositories: parsedRepos
      .filter((repo): repo is { nameWithOwner: string } => typeof repo.nameWithOwner === "string")
      .map((repo) => ({ id: repo.nameWithOwner, label: repo.nameWithOwner })),
    organizations: parsedOrgs
      .filter((org): org is { login: string } => typeof org.login === "string")
      .map((org) => ({ id: org.login, label: org.login })),
  };
}

export async function runInteractiveSetup({
  context,
  discoverTargets = discoverGitHubTargets,
  prompts = clackPrompts,
}: {
  context: SetupContext;
  discoverTargets?: () => Promise<SetupTargets>;
  prompts?: SetupPromptAdapter;
}): Promise<SetupSelection> {
  if (!context.stdin.isTTY) {
    context.stdout.write("Setup requires an interactive terminal; run codex-github-router in a TTY to choose repositories and organizations.\n");
    return { repositories: [], organizations: [], setupRequired: true };
  }

  prompts.intro("Interactive setup", context);

  const targets = await discoverTargets();
  const selectedOrganizations = await prompts.multiselectTargets({
    message: "Select organizations for organization webhooks",
    items: targets.organizations,
    context,
  });
  if (selectedOrganizations === CANCELLED) {
    return cancelSetup(prompts, context);
  }

  const selectedRepositories = await prompts.multiselectTargets({
    message: "Select repositories for repository webhooks",
    items: targets.repositories,
    context,
  });
  if (selectedRepositories === CANCELLED) {
    return cancelSetup(prompts, context);
  }

  const configuredOrganizations = configureTargets(selectedOrganizations);
  const configuredRepositories = configureTargets(selectedRepositories);
  const completed = await settingsMenu({
    repositories: configuredRepositories,
    organizations: configuredOrganizations,
    context,
    prompts,
  });
  if (!completed) {
    return cancelSetup(prompts, context);
  }
  prompts.outro("Setup saved. Starting router...", context);

  return {
    repositories: configuredRepositories.map((target) => ({
      fullName: target.id,
      enabled: target.enabled,
      issueAutomationEnabled: target.issueAutomationEnabled,
      issueAutomationLabel: target.issueAutomationLabel,
      issueAutomationPrompt: target.issueAutomationPrompt,
    })),
    organizations: configuredOrganizations.map((target) => ({
      login: target.id,
      enabled: target.enabled,
      issueAutomationEnabled: target.issueAutomationEnabled,
      issueAutomationLabel: target.issueAutomationLabel,
      issueAutomationPrompt: target.issueAutomationPrompt,
    })),
    setupRequired: false,
  };
}

export async function runInteractiveSettings({
  context,
  selection,
  prompts = clackPrompts,
}: {
  context: SetupContext;
  selection: SetupSelection;
  prompts?: SetupPromptAdapter;
}): Promise<SetupSelection | null> {
  if (!context.stdin.isTTY) {
    context.stdout.write("Settings require an interactive terminal.\n");
    return null;
  }

  prompts.intro("Settings", context);
  const configuredOrganizations = selection.organizations.map((organization) => ({
    id: organization.login,
    label: organization.login,
    enabled: organization.enabled,
    issueAutomationEnabled: organization.issueAutomationEnabled,
    issueAutomationLabel: organization.issueAutomationLabel,
    issueAutomationPrompt: organization.issueAutomationPrompt,
  }));
  const configuredRepositories = selection.repositories.map((repository) => ({
    id: repository.fullName,
    label: repository.fullName,
    enabled: repository.enabled,
    issueAutomationEnabled: repository.issueAutomationEnabled,
    issueAutomationLabel: repository.issueAutomationLabel,
    issueAutomationPrompt: repository.issueAutomationPrompt,
  }));
  const completed = await settingsMenu({
    repositories: configuredRepositories,
    organizations: configuredOrganizations,
    context,
    prompts,
    finishLabel: "Save settings",
  });
  if (!completed) {
    prompts.cancel("Settings cancelled. Existing settings were kept.", context);
    return null;
  }
  prompts.outro("Settings saved.", context);

  return {
    repositories: configuredRepositories.map((target) => ({
      fullName: target.id,
      enabled: target.enabled,
      issueAutomationEnabled: target.issueAutomationEnabled,
      issueAutomationLabel: target.issueAutomationLabel,
      issueAutomationPrompt: target.issueAutomationPrompt,
    })),
    organizations: configuredOrganizations.map((target) => ({
      login: target.id,
      enabled: target.enabled,
      issueAutomationEnabled: target.issueAutomationEnabled,
      issueAutomationLabel: target.issueAutomationLabel,
      issueAutomationPrompt: target.issueAutomationPrompt,
    })),
    setupRequired: selection.setupRequired,
  };
}

function configureTargets(targets: SetupTarget[]): ConfiguredTarget[] {
  return targets.map((target) => ({
    ...target,
    enabled: true,
    issueAutomationEnabled: false,
    issueAutomationLabel: DEFAULT_ISSUE_AUTOMATION_LABEL,
    issueAutomationPrompt: DEFAULT_ISSUE_AUTOMATION_PROMPT,
  }));
}

async function settingsMenu({
  repositories,
  organizations,
  context,
  prompts,
  finishLabel = "Finish setup",
}: {
  repositories: ConfiguredTarget[];
  organizations: ConfiguredTarget[];
  context: SetupContext;
  prompts: SetupPromptAdapter;
  finishLabel?: string;
}): Promise<boolean> {
  while (true) {
    const choice = await prompts.selectSettings({ context, finishLabel });
    if (choice === CANCELLED) return false;
    if (choice === "organizations") {
      const completed = await targetSettingsMenu({
        title: "Organization-level settings",
        targets: organizations,
        context,
        prompts,
      });
      if (!completed) return false;
    } else if (choice === "repositories") {
      const completed = await targetSettingsMenu({
        title: "Repository-level settings",
        targets: repositories,
        context,
        prompts,
      });
      if (!completed) return false;
    } else {
      return true;
    }
  }
}

async function targetSettingsMenu({
  title,
  targets,
  context,
  prompts,
}: {
  title: string;
  targets: ConfiguredTarget[];
  context: SetupContext;
  prompts: SetupPromptAdapter;
}): Promise<boolean> {
  while (true) {
    const targetId = await prompts.selectTarget({ title, targets, context });
    if (targetId === CANCELLED) return false;
    if (targetId === "back") return true;
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) continue;
    const completed = await editTargetSettings({ title: target.label, target, context, prompts });
    if (!completed) return false;
  }
}

async function editTargetSettings({
  title,
  target,
  context,
  prompts,
}: {
  title: string;
  target: ConfiguredTarget;
  context: SetupContext;
  prompts: SetupPromptAdapter;
}): Promise<boolean> {
  while (true) {
    const choice = await prompts.selectTargetSetting({ title, target, context });
    if (choice === CANCELLED) return false;
    if (choice === "back") return true;
    if (choice === "toggle-enabled") {
      target.enabled = !target.enabled;
    } else if (choice === "toggle-issue-automation") {
      target.issueAutomationEnabled = !target.issueAutomationEnabled;
    } else if (choice === "set-issue-label") {
      const label = await prompts.text({
        message: "Issue automation label",
        initialValue: target.issueAutomationLabel,
        context,
      });
      if (label === CANCELLED) return false;
      target.issueAutomationLabel = label.trim() || DEFAULT_ISSUE_AUTOMATION_LABEL;
    } else if (choice === "set-issue-prompt") {
      const prompt = await prompts.text({
        message: "Issue automation prompt",
        initialValue: target.issueAutomationPrompt,
        context,
      });
      if (prompt === CANCELLED) return false;
      target.issueAutomationPrompt = prompt.trim() || DEFAULT_ISSUE_AUTOMATION_PROMPT;
    }
  }
}

function cancelSetup(prompts: SetupPromptAdapter, context: SetupContext): SetupSelection {
  prompts.cancel("Setup cancelled. Run codex-github-router again to finish setup.", context);
  return { repositories: [], organizations: [], setupRequired: true };
}

const clackPrompts: SetupPromptAdapter = {
  intro(message, context) {
    intro(message, { input: context.stdin, output: context.stdout });
  },
  async multiselectTargets({ message, items, context }) {
    if (items.length === 0) {
      note("No choices found.", message, { output: context.stdout });
      return [];
    }
    const selected = await multiselect({
      message,
      options: items.map((item) => ({ value: item.id, label: item.label })),
      required: false,
      input: context.stdin,
      output: context.stdout,
    });
    if (isCancel(selected)) return CANCELLED;
    const selectedIds = new Set(selected);
    return items.filter((item) => selectedIds.has(item.id));
  },
  async selectSettings({ context, finishLabel }) {
    const choice = await select<SettingsChoice>({
      message: "Settings",
      options: [
        { value: "organizations", label: "Organization-level settings" },
        { value: "repositories", label: "Repository-level settings" },
        { value: "finish", label: finishLabel },
      ],
      input: context.stdin,
      output: context.stdout,
    });
    if (isCancel(choice)) return CANCELLED;
    return choice;
  },
  async selectTarget({ title, targets, context }) {
    if (targets.length === 0) {
      note("No targets selected.", title, { output: context.stdout });
      return "back";
    }
    const choice = await select<TargetChoice>({
      message: title,
      options: [
        ...targets.map((target) => ({
          value: target.id,
          label: target.label,
          hint: `${target.enabled ? "webhooks on" : "webhooks off"}, issue automation ${target.issueAutomationEnabled ? "on" : "off"}, label ${target.issueAutomationLabel}`,
        })),
        { value: "back", label: "Back to settings" },
      ],
      input: context.stdin,
      output: context.stdout,
    });
    if (isCancel(choice)) return CANCELLED;
    return choice;
  },
  async selectTargetSetting({ title, target, context }) {
    const choice = await select<TargetSettingChoice>({
      message: title,
      options: [
        {
          value: "toggle-enabled",
          label: `${target.enabled ? "Disable" : "Enable"} webhooks`,
          hint: target.enabled ? "currently enabled" : "currently disabled",
        },
        {
          value: "toggle-issue-automation",
          label: `${target.issueAutomationEnabled ? "Disable" : "Enable"} issue automation`,
          hint: target.issueAutomationEnabled ? "currently enabled" : "currently disabled",
        },
        {
          value: "set-issue-label",
          label: "Set issue automation label",
          hint: target.issueAutomationLabel,
        },
        {
          value: "set-issue-prompt",
          label: "Set issue automation prompt",
          hint: target.issueAutomationPrompt,
        },
        { value: "back", label: "Back to targets" },
      ],
      input: context.stdin,
      output: context.stdout,
    });
    if (isCancel(choice)) return CANCELLED;
    return choice;
  },
  async text({ message, initialValue, context }) {
    const value = await text({
      message,
      initialValue,
      input: context.stdin,
      output: context.stdout,
    });
    if (isCancel(value)) return CANCELLED;
    return value;
  },
  note({ title, message, context }) {
    note(message, title, { output: context.stdout });
  },
  outro(message, context) {
    outro(message, { output: context.stdout });
  },
  cancel(message, context) {
    cancel(message, { output: context.stdout });
  },
};
