import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateWebhookSecret } from "./security.js";
import type { RouterConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const WEBHOOK_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"];

export interface WebhookSyncResult {
  repositories: Array<{ fullName: string; hookId: number | string; action: "created" | "updated" }>;
  organizations: Array<{ login: string; hookId: number | string; action: "created" | "updated" }>;
}

type GhApi = (args: string[]) => Promise<string>;

export async function syncGitHubWebhooks({
  config,
  publicWebhookUrl,
  env = process.env,
  ghApi = defaultGhApi,
}: {
  config: RouterConfig;
  publicWebhookUrl: string;
  env?: NodeJS.ProcessEnv;
  ghApi?: GhApi;
}): Promise<WebhookSyncResult> {
  const result: WebhookSyncResult = { repositories: [], organizations: [] };
  const envSecret = env.CODEX_GITHUB_ROUTER_WEBHOOK_SECRET;
  const secret = config.webhookSecret ?? envSecret ?? generateWebhookSecret();
  if (!envSecret || config.webhookSecret) {
    config.webhookSecret = secret;
  }

  for (const target of configuredTargets(config.organizations, "login")) {
    const synced = await syncTargetWebhook({
      apiPath: `/orgs/${target.login}/hooks`,
      publicWebhookUrl,
      secret,
      ghApi,
    });
    target.hookId = synced.hookId;
    result.organizations.push({ login: target.login, ...synced });
  }

  for (const target of configuredTargets(config.repositories, "fullName")) {
    const synced = await syncTargetWebhook({
      apiPath: `/repos/${target.fullName}/hooks`,
      publicWebhookUrl,
      secret,
      ghApi,
    });
    target.hookId = synced.hookId;
    result.repositories.push({ fullName: target.fullName, ...synced });
  }

  config.hasStoredSecrets = Boolean(config.webhookSecret);
  return result;
}

async function syncTargetWebhook({
  apiPath,
  publicWebhookUrl,
  secret,
  ghApi,
}: {
  apiPath: string;
  publicWebhookUrl: string;
  secret: string;
  ghApi: GhApi;
}): Promise<{ hookId: number | string; action: "created" | "updated" }> {
  const hooks = parseHooks(await ghApi([apiPath]));
  const existing = hooks.find((hook) => hook.config?.url === publicWebhookUrl);
  const fields = webhookFields(publicWebhookUrl, secret);

  if (existing?.id !== undefined) {
    await ghApi(["-X", "PATCH", `${apiPath}/${existing.id}`, ...fields]);
    return { hookId: existing.id, action: "updated" };
  }

  const created = parseHook(await ghApi(["-X", "POST", apiPath, ...fields]));
  if (created.id === undefined) {
    throw new Error(`GitHub did not return a hook id for ${apiPath}`);
  }
  return { hookId: created.id, action: "created" };
}

function webhookFields(publicWebhookUrl: string, secret: string): string[] {
  return [
    "-f", "name=web",
    "-F", "active=true",
    "-f", `config[url]=${publicWebhookUrl}`,
    "-f", "config[content_type]=json",
    "-f", `config[secret]=${secret}`,
    "-f", "config[insecure_ssl]=0",
    ...WEBHOOK_EVENTS.flatMap((event) => ["-f", `events[]=${event}`]),
  ];
}

function configuredTargets(targets: unknown[] | undefined, idKey: "login"): Array<Record<string, unknown> & { login: string; webhookSecret?: string; hookId?: number | string }>;
function configuredTargets(targets: unknown[] | undefined, idKey: "fullName"): Array<Record<string, unknown> & { fullName: string; webhookSecret?: string; hookId?: number | string }>;
function configuredTargets(targets: unknown[] | undefined, idKey: "login" | "fullName") {
  return (targets ?? []).flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return [];
    }
    const record = target as Record<string, unknown>;
    if (record.enabled === false || typeof record[idKey] !== "string") {
      return [];
    }
    return [record];
  });
}

interface GitHubHook {
  id?: number | string;
  config?: { url?: string };
}

function parseHooks(stdout: string): GitHubHook[] {
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? parsed.flatMap((value) => parseHook(value)) : [];
}

function parseHook(value: unknown): GitHubHook {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const config = record.config && typeof record.config === "object" && !Array.isArray(record.config)
    ? record.config as Record<string, unknown>
    : {};
  const hook: GitHubHook = {};
  if (typeof record.id === "number" || typeof record.id === "string") {
    hook.id = record.id;
  }
  if (typeof config.url === "string") {
    hook.config = { url: config.url };
  }
  return hook;
}

async function defaultGhApi(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["api", ...args], { timeout: 30000 });
  return stdout;
}
