import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cancel, intro, isCancel, multiselect, note, outro, select } from "@clack/prompts";
import type { RuntimeContext } from "./types.js";

const execFileAsync = promisify(execFile);
const CANCELLED = "cancelled";

export interface SetupTarget {
  id: string;
  label: string;
}

export interface SetupSelection {
  repositories: Array<{ fullName: string; enabled: boolean; issueAutomationEnabled: boolean }>;
  organizations: Array<{ login: string; enabled: boolean; issueAutomationEnabled: boolean }>;
  setupRequired: boolean;
}

export interface SetupTargets {
  repositories: SetupTarget[];
  organizations: SetupTarget[];
}

type SetupContext = Pick<RuntimeContext, "stdin" | "stdout" | "stderr" | "env">;
type Cancelled = typeof CANCELLED;
type SettingsChoice = "repositories" | "organizations" | "finish";

interface SetupPromptAdapter {
  intro(message: string, context: SetupContext): void;
  multiselectTargets(args: { message: string; items: SetupTarget[]; context: SetupContext }): Promise<SetupTarget[] | Cancelled>;
  selectSettings(args: { context: SetupContext }): Promise<SettingsChoice | Cancelled>;
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

  prompts.intro("codex-github-router setup", context);

  const targets = await discoverTargets();
  const selectedRepositories = await prompts.multiselectTargets({
    message: "Select repositories for repository webhooks",
    items: targets.repositories,
    context,
  });
  if (selectedRepositories === CANCELLED) {
    return cancelSetup(prompts, context);
  }

  const selectedOrganizations = await prompts.multiselectTargets({
    message: "Select organizations for organization webhooks",
    items: targets.organizations,
    context,
  });
  if (selectedOrganizations === CANCELLED) {
    return cancelSetup(prompts, context);
  }

  const completed = await settingsMenu({
    repositories: selectedRepositories,
    organizations: selectedOrganizations,
    context,
    prompts,
  });
  if (!completed) {
    return cancelSetup(prompts, context);
  }
  prompts.outro("Setup saved. Starting router...", context);

  return {
    repositories: selectedRepositories.map((target) => ({
      fullName: target.id,
      enabled: true,
      issueAutomationEnabled: false,
    })),
    organizations: selectedOrganizations.map((target) => ({
      login: target.id,
      enabled: true,
      issueAutomationEnabled: false,
    })),
    setupRequired: false,
  };
}

async function settingsMenu({
  repositories,
  organizations,
  context,
  prompts,
}: {
  repositories: SetupTarget[];
  organizations: SetupTarget[];
  context: SetupContext;
  prompts: SetupPromptAdapter;
}): Promise<boolean> {
  while (true) {
    const choice = await prompts.selectSettings({ context });
    if (choice === CANCELLED) return false;
    if (choice === "repositories") {
      prompts.note({
        title: "Repository-level settings",
        message: settingsSummary(repositories),
        context,
      });
    } else if (choice === "organizations") {
      prompts.note({
        title: "Organization-level settings",
        message: settingsSummary(organizations),
        context,
      });
    } else {
      return true;
    }
  }
}

function settingsSummary(targets: SetupTarget[]): string {
  const selectedTargets = targets.length === 0 ? "No targets selected." : targets.map((target) => `- ${target.label}`).join("\n");
  return `Defaults: webhooks enabled, issue automation off, label ready-for-agent.\n${selectedTargets}`;
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
  async selectSettings({ context }) {
    const choice = await select<SettingsChoice>({
      message: "Settings",
      options: [
        { value: "repositories", label: "Repository-level settings" },
        { value: "organizations", label: "Organization-level settings" },
        { value: "finish", label: "Finish setup" },
      ],
      input: context.stdin,
      output: context.stdout,
    });
    if (isCancel(choice)) return CANCELLED;
    return choice;
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
