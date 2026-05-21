import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cancel, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { colorize } from "./output.js";
import type { RuntimeContext } from "./types.js";

const execFileAsync = promisify(execFile);
const CANCELLED = "cancelled";
const DEFAULT_ISSUE_AUTOMATION_LABEL = "ready-for-agent";
const DEFAULT_ISSUE_AUTOMATION_PROMPT = "Develop this issue using TDD, open a pull request, and report verification steps.";
export const SETUP_TITLE = [
  "",
  "               C Y B E R P U N K    E V E N T    R O U T I N G    A C T I O N",
  "                  __                   _ __  __          __                        __           ",
  "  _________  ____/ /__  _  __   ____ _(_) /_/ /_  __  __/ /_     _________  __  __/ /____  _____",
  " / ___/ __ \\/ __  / _ \\| |/_/  / __ `/ / __/ __ \\/ / / / __ \\   / ___/ __ \\/ / / / __/ _ \\/ ___/",
  "/ /__/ /_/ / /_/ /  __/>  <   / /_/ / / /_/ / / / /_/ / /_/ /  / /  / /_/ / /_/ / /_/  __/ /    ",
  "\\___/\\____/\\__,_/\\___/_/|_|   \\__, /_/\\__/_/ /_/\\__,_/_.___/  /_/   \\____/\\__,_/\\__/\\___/_/     ",
  "                             /____/                                                             ",
  "",
].join("\n");

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
type SetupExecFile = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
type Cancelled = typeof CANCELLED;
type SettingsChoice = "organizations" | "repositories" | "finish";
type TargetChoice = string | "back";
type TargetSettingChoice = "toggle-enabled" | "toggle-issue-automation" | "set-issue-label" | "set-issue-prompt" | "back";
type MenuResult = "finish" | "back";
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

async function defaultSetupExecFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, [...args], { timeout: 15000 });
  return { stdout, stderr };
}

export async function discoverGitHubTargets(runExecFile: SetupExecFile = defaultSetupExecFile): Promise<SetupTargets> {
  const [repos, orgs] = await Promise.all([
    runExecFile("gh", ["repo", "list", "--limit", "100", "--json", "nameWithOwner"]),
    runExecFile("gh", ["api", "--paginate", "--slurp", "user/orgs"]),
  ]);

  const parsedRepos = JSON.parse(repos.stdout) as Array<{ nameWithOwner?: string }>;
  const parsedOrgPages = JSON.parse(orgs.stdout) as Array<Array<{ login?: string }>>;
  const parsedOrgs = parsedOrgPages.flat();
  const organizations = parsedOrgs
    .filter((org): org is { login: string } => typeof org.login === "string")
    .map((org) => ({ id: org.login, label: org.login }));

  return {
    repositories: parsedRepos
      .filter((repo): repo is { nameWithOwner: string } => typeof repo.nameWithOwner === "string")
      .map((repo) => ({ id: repo.nameWithOwner, label: repo.nameWithOwner })),
    organizations,
  };
}

export async function discoverOrganizationRepositories(organizations: SetupTarget[]): Promise<SetupTarget[]> {
  const orgRepoResults = await Promise.all(
    organizations.map((org) => execFileAsync("gh", ["repo", "list", org.id, "--limit", "100", "--json", "nameWithOwner"], { timeout: 15000 })),
  );
  const orgRepos = orgRepoResults.flatMap((result) => JSON.parse(result.stdout) as Array<{ nameWithOwner?: string }>);
  return uniqueTargets(orgRepos
    .filter((repo): repo is { nameWithOwner: string } => typeof repo.nameWithOwner === "string")
    .map((repo) => ({ id: repo.nameWithOwner, label: repo.nameWithOwner })));
}

export async function runInteractiveSetup({
  context,
  discoverTargets = discoverGitHubTargets,
  discoverRepositoriesForOrganizations = discoverOrganizationRepositories,
  prompts = clackPrompts,
}: {
  context: SetupContext;
  discoverTargets?: () => Promise<SetupTargets>;
  discoverRepositoriesForOrganizations?: (organizations: SetupTarget[]) => Promise<SetupTarget[]>;
  prompts?: SetupPromptAdapter;
}): Promise<SetupSelection> {
  if (!context.stdin.isTTY) {
    context.stdout.write("Setup requires an interactive terminal; run codex-github-router in a TTY to choose repositories and organizations.\n");
    return { repositories: [], organizations: [], setupRequired: true };
  }

  prompts.intro("Welcome to the night shift", context);

  const targets = await discoverTargets();
  let selectedOrganizations: SetupTarget[] | null = null;

  while (true) {
    if (selectedOrganizations === null) {
      const organizationSelection = await prompts.multiselectTargets({
        message: "Select organizations for organization webhooks",
        items: targets.organizations,
        context,
      });
      if (organizationSelection === CANCELLED) {
        return cancelSetup(prompts, context);
      }
      selectedOrganizations = organizationSelection;
    }

    const availableRepositories = uniqueTargets([
      ...targets.repositories,
      ...await discoverRepositoriesForOrganizations(selectedOrganizations),
    ]);

    const selectedRepositories = await prompts.multiselectTargets({
      message: "Select repositories for repository webhooks",
      items: availableRepositories,
      context,
    });
    if (selectedRepositories === CANCELLED) {
      selectedOrganizations = null;
      continue;
    }

    const configuredOrganizations = configureTargets(selectedOrganizations);
    const configuredRepositories = configureRepositoryTargets({
      targets: repositorySettingsTargets({
        selectedRepositories,
        selectedOrganizations,
        availableRepositories,
      }),
      selectedRepositories,
    });
    const menuResult = await settingsMenu({
      repositories: configuredRepositories,
      organizations: configuredOrganizations,
      context,
      prompts,
    });
    if (menuResult === "back") {
      continue;
    }
    prompts.outro("Setup saved. Commencing simulation...", context);

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
  const menuResult = await settingsMenu({
    repositories: configuredRepositories,
    organizations: configuredOrganizations,
    context,
    prompts,
    finishLabel: "Save settings",
  });
  if (menuResult === "back") {
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

function configureRepositoryTargets({
  targets,
  selectedRepositories,
}: {
  targets: SetupTarget[];
  selectedRepositories: SetupTarget[];
}): ConfiguredTarget[] {
  const selectedRepositoryIds = new Set(selectedRepositories.map((repository) => repository.id));
  return configureTargets(targets).map((target) => ({
    ...target,
    enabled: selectedRepositoryIds.has(target.id),
  }));
}

function repositorySettingsTargets({
  selectedRepositories,
  selectedOrganizations,
  availableRepositories,
}: {
  selectedRepositories: SetupTarget[];
  selectedOrganizations: SetupTarget[];
  availableRepositories: SetupTarget[];
}): SetupTarget[] {
  const organizationLogins = new Set(selectedOrganizations.map((organization) => organization.id));
  const organizationRepositories = availableRepositories.filter((repository) => {
    const [owner] = repository.id.split("/");
    return owner ? organizationLogins.has(owner) : false;
  });
  return uniqueTargets([...selectedRepositories, ...organizationRepositories]);
}

function uniqueTargets(targets: SetupTarget[]): SetupTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.id)) {
      return false;
    }
    seen.add(target.id);
    return true;
  });
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
}): Promise<MenuResult> {
  while (true) {
    const choice = await prompts.selectSettings({ context, finishLabel });
    if (choice === CANCELLED) return "back";
    if (choice === "organizations") {
      await targetSettingsMenu({
        title: "Organization-level settings",
        targets: organizations,
        context,
        prompts,
      });
    } else if (choice === "repositories") {
      await targetSettingsMenu({
        title: "Repository-level settings",
        targets: repositories,
        context,
        prompts,
      });
    } else {
      return "finish";
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
}): Promise<MenuResult> {
  while (true) {
    const targetId = await prompts.selectTarget({ title, targets, context });
    if (targetId === CANCELLED) return "back";
    if (targetId === "back") return "back";
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) continue;
    await editTargetSettings({ title: target.label, target, context, prompts });
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
}): Promise<MenuResult> {
  while (true) {
    const choice = await prompts.selectTargetSetting({ title, target, context });
    if (choice === CANCELLED) return "back";
    if (choice === "back") return "back";
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
      if (label === CANCELLED) continue;
      target.issueAutomationLabel = label.trim() || DEFAULT_ISSUE_AUTOMATION_LABEL;
    } else if (choice === "set-issue-prompt") {
      const prompt = await prompts.text({
        message: "Issue automation prompt",
        initialValue: target.issueAutomationPrompt,
        context,
      });
      if (prompt === CANCELLED) continue;
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
      message: `${message} ${colorize("(space to toggle)", "dim", { env: context.env, stream: context.stdout })}`,
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
