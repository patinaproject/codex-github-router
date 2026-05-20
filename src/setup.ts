import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { colorize } from "./output.js";
import type { RuntimeContext } from "./types.js";

const execFileAsync = promisify(execFile);

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
}: {
  context: SetupContext;
  discoverTargets?: () => Promise<SetupTargets>;
}): Promise<SetupSelection> {
  if (!context.stdin.isTTY) {
    context.stdout.write("Setup requires an interactive terminal; run codex-github-router in a TTY to choose repositories and organizations.\n");
    return { repositories: [], organizations: [], setupRequired: true };
  }

  context.stdout.write(`${colorize("Interactive setup", "bold", { env: context.env, stream: context.stdout })}\n`);
  context.stdout.write("Use arrow keys or j/k to move, Space to select, Enter to continue.\n\n");

  const targets = await discoverTargets();
  const selectedRepositories = await selectMany({
    title: "Select repositories for repository webhooks",
    items: targets.repositories,
    context,
  });
  const selectedOrganizations = await selectMany({
    title: "Select organizations for organization webhooks",
    items: targets.organizations,
    context,
  });
  await settingsMenu({
    repositories: selectedRepositories,
    organizations: selectedOrganizations,
    context,
  });

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

async function selectMany({
  title,
  items,
  context,
}: {
  title: string;
  items: SetupTarget[];
  context: SetupContext;
}): Promise<SetupTarget[]> {
  if (items.length === 0) {
    context.stdout.write(`${title}\nNo choices found.\n\n`);
    return [];
  }

  let index = 0;
  const selected = new Set<string>();
  const keys = createKeyReader(context.stdin);
  keys.open();
  try {
    while (true) {
      renderSelect(context.stdout, title, items, index, selected);
      const key = await keys.next();
      if (key === "up") index = Math.max(0, index - 1);
      else if (key === "down") index = Math.min(items.length - 1, index + 1);
      else if (key === "space") {
        const id = items[index]?.id;
        if (id && selected.has(id)) selected.delete(id);
        else if (id) selected.add(id);
      } else if (key === "enter") {
        context.stdout.write("\n");
        return items.filter((item) => selected.has(item.id));
      }
    }
  } finally {
    keys.close();
  }
}

async function settingsMenu({
  repositories,
  organizations,
  context,
}: {
  repositories: SetupTarget[];
  organizations: SetupTarget[];
  context: SetupContext;
}): Promise<void> {
  const sections = ["Repository-level settings", "Organization-level settings", "Finish setup"];
  let index = 0;
  const keys = createKeyReader(context.stdin);
  keys.open();
  try {
    while (true) {
      renderMenu(context.stdout, "Settings", sections, index);
      const key = await keys.next();
      if (key === "up") index = Math.max(0, index - 1);
      else if (key === "down") index = Math.min(sections.length - 1, index + 1);
      else if (key === "enter") {
        if (index === 0) {
          renderSettingsSection(context.stdout, "Repository-level settings", repositories);
        } else if (index === 1) {
          renderSettingsSection(context.stdout, "Organization-level settings", organizations);
        } else {
          context.stdout.write("\n");
          return;
        }
        await keys.next();
      }
    }
  } finally {
    keys.close();
  }
}

function renderSelect(stdout: SetupContext["stdout"], title: string, items: SetupTarget[], index: number, selected: Set<string>): void {
  stdout.write(`\n${title}\n`);
  for (const [itemIndex, item] of items.entries()) {
    const cursor = itemIndex === index ? ">" : " ";
    const mark = selected.has(item.id) ? "[x]" : "[ ]";
    stdout.write(`${cursor} ${mark} ${item.label}\n`);
  }
}

function renderMenu(stdout: SetupContext["stdout"], title: string, items: string[], index: number): void {
  stdout.write(`\n${title}\n`);
  for (const [itemIndex, item] of items.entries()) {
    const cursor = itemIndex === index ? ">" : " ";
    stdout.write(`${cursor} ${item}\n`);
  }
}

function renderSettingsSection(stdout: SetupContext["stdout"], title: string, targets: SetupTarget[]): void {
  stdout.write(`\n${title}\n`);
  stdout.write("Defaults: webhooks enabled, issue automation off, label ready-for-agent.\n");
  if (targets.length === 0) {
    stdout.write("No targets selected.\n");
  } else {
    for (const target of targets) {
      stdout.write(`- ${target.label}\n`);
    }
  }
  stdout.write("Press any key to return.\n");
}

function createKeyReader(stdin: SetupContext["stdin"]): {
  open: () => void;
  close: () => void;
  next: () => Promise<string>;
} {
  const pending: string[] = [];
  const waiters: Array<(key: string) => void> = [];
  const previousRawMode = typeof stdin.isRaw === "boolean" ? stdin.isRaw : false;
  const setRawMode = typeof stdin.setRawMode === "function" ? (value: boolean) => stdin.setRawMode?.(value) : undefined;

  const onData = (chunk: Buffer | string): void => {
    for (const key of parseKeys(chunk.toString("utf8"))) {
      const waiter = waiters.shift();
      if (waiter) waiter(key);
      else pending.push(key);
    }
  };

  return {
    open() {
      setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
    },
    close() {
      stdin.off("data", onData);
      setRawMode?.(previousRawMode);
    },
    next() {
      const key = pending.shift();
      if (key) return Promise.resolve(key);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function parseKeys(input: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input.slice(index, index + 3);
    if (next === "\u001b[A") {
      keys.push("up");
      index += 2;
    } else if (next === "\u001b[B") {
      keys.push("down");
      index += 2;
    } else if (char === "k") keys.push("up");
    else if (char === "j") keys.push("down");
    else if (char === " ") keys.push("space");
    else if (char === "\r" || char === "\n") keys.push("enter");
    else keys.push(char.toLowerCase());
  }
  return keys;
}

export { parseKeys };
