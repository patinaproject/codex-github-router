import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GITHUB_WEBHOOK_EVENTS } from "./github-events.js";
import { generateWebhookSecret } from "./security.js";
import type { RouterConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface WebhookSyncResult {
  repositories: Array<{ fullName: string; hookId: number | string; action: "created" | "updated" }>;
  organizations: Array<{ login: string; hookId: number | string; action: "created" | "updated" }>;
  warnings: Array<{ target: string; code: "hook_id_missing" | "hook_missing"; message: string }>;
}

export interface WebhookDeleteResult {
  repositories: Array<{ fullName: string; hookId: number | string; action: "deleted" | "already_missing" }>;
  organizations: Array<{ login: string; hookId: number | string; action: "deleted" | "already_missing" }>;
}

type GhApi = (args: string[]) => Promise<string>;

export async function syncGitHubWebhooks({
  config,
  publicWebhookUrl,
  env = process.env,
  ghApi = defaultGhApi,
  createMissing = true,
}: {
  config: RouterConfig;
  publicWebhookUrl: string;
  env?: NodeJS.ProcessEnv;
  ghApi?: GhApi;
  createMissing?: boolean;
}): Promise<WebhookSyncResult> {
  const result: WebhookSyncResult = { repositories: [], organizations: [], warnings: [] };
  const envSecret = env.CODEX_GITHUB_ROUTER_WEBHOOK_SECRET;
  const secret = config.webhookSecret ?? envSecret ?? generateWebhookSecret();
  if (!envSecret || config.webhookSecret) {
    config.webhookSecret = secret;
  }

  for (const target of configuredTargets(config.organizations, "login")) {
    const synced = await syncTargetWebhook({
      apiPath: `/orgs/${target.login}/hooks`,
      target: target.login,
      hookId: target.hookId,
      publicWebhookUrl,
      secret,
      ghApi,
      createMissing,
    });
    if (synced.warning) {
      result.warnings.push(synced.warning);
      continue;
    }
    target.hookId = synced.hookId;
    result.organizations.push({ login: target.login, ...synced });
  }

  for (const target of configuredTargets(config.repositories, "fullName")) {
    const synced = await syncTargetWebhook({
      apiPath: `/repos/${target.fullName}/hooks`,
      target: target.fullName,
      hookId: target.hookId,
      publicWebhookUrl,
      secret,
      ghApi,
      createMissing,
    });
    if (synced.warning) {
      result.warnings.push(synced.warning);
      continue;
    }
    target.hookId = synced.hookId;
    result.repositories.push({ fullName: target.fullName, ...synced });
  }

  config.hasStoredSecrets = Boolean(config.webhookSecret);
  return result;
}

export async function deleteGitHubWebhooks({
  config,
  ghApi = defaultGhApi,
}: {
  config: RouterConfig;
  ghApi?: GhApi;
}): Promise<WebhookDeleteResult> {
  const result: WebhookDeleteResult = { repositories: [], organizations: [] };

  for (const target of targetsWithHookIds(config.organizations, "login")) {
    const action = await deleteTargetWebhook({
      apiPath: `/orgs/${target.login}/hooks/${target.hookId}`,
      ghApi,
    });
    result.organizations.push({ login: target.login, hookId: target.hookId, action });
  }

  for (const target of targetsWithHookIds(config.repositories, "fullName")) {
    const action = await deleteTargetWebhook({
      apiPath: `/repos/${target.fullName}/hooks/${target.hookId}`,
      ghApi,
    });
    result.repositories.push({ fullName: target.fullName, hookId: target.hookId, action });
  }

  return result;
}

async function syncTargetWebhook({
  apiPath,
  target,
  hookId,
  publicWebhookUrl,
  secret,
  ghApi,
  createMissing,
}: {
  apiPath: string;
  target: string;
  hookId: number | string | undefined;
  publicWebhookUrl: string;
  secret: string;
  ghApi: GhApi;
  createMissing: boolean;
}): Promise<
  | { hookId: number | string; action: "created" | "updated"; warning?: never }
  | { warning: WebhookSyncResult["warnings"][number]; hookId?: never; action?: never }
> {
  const fields = webhookFields(publicWebhookUrl, secret);

  if (hookId !== undefined) {
    try {
      await ghApi(["-X", "PATCH", `${apiPath}/${hookId}`, ...fields]);
      return { hookId, action: "updated" };
    } catch (error) {
      if (!isMissingHookError(error)) {
        throw error;
      }
      if (createMissing) {
        return createTargetWebhook({ apiPath, fields, ghApi });
      }
      return {
        warning: {
          target,
          code: "hook_missing",
          message: `Remembered GitHub webhook ${hookId} for ${target} no longer exists.`,
        },
      };
    }
  }

  if (!createMissing) {
    return {
      warning: {
        target,
        code: "hook_id_missing",
        message: `No remembered GitHub hook ID for ${target}; reload will not create a new webhook.`,
      },
    };
  }

  return createTargetWebhook({ apiPath, fields, ghApi });
}

async function createTargetWebhook({
  apiPath,
  fields,
  ghApi,
}: {
  apiPath: string;
  fields: string[];
  ghApi: GhApi;
}): Promise<{ hookId: number | string; action: "created" }> {
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
    ...GITHUB_WEBHOOK_EVENTS.flatMap((event) => ["-f", `events[]=${event}`]),
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

function targetsWithHookIds(targets: unknown[] | undefined, idKey: "login"): Array<Record<string, unknown> & { login: string; hookId: number | string }>;
function targetsWithHookIds(targets: unknown[] | undefined, idKey: "fullName"): Array<Record<string, unknown> & { fullName: string; hookId: number | string }>;
function targetsWithHookIds(targets: unknown[] | undefined, idKey: "login" | "fullName") {
  return (targets ?? []).flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return [];
    }
    const record = target as Record<string, unknown>;
    const hookId = record.hookId;
    if (typeof record[idKey] !== "string" || (typeof hookId !== "number" && typeof hookId !== "string")) {
      return [];
    }
    return [record];
  });
}

interface GitHubHook {
  id?: number | string;
  config?: { url?: string };
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

function isMissingHookError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("404") || error.message.includes("Not Found");
}

async function deleteTargetWebhook({
  apiPath,
  ghApi,
}: {
  apiPath: string;
  ghApi: GhApi;
}): Promise<"deleted" | "already_missing"> {
  try {
    await ghApi(["-X", "DELETE", apiPath]);
    return "deleted";
  } catch (error) {
    if (isMissingHookError(error)) {
      return "already_missing";
    }
    throw error;
  }
}

async function defaultGhApi(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", ["api", ...args], { timeout: 30000 });
    return stdout;
  } catch (error) {
    throw new Error(sanitizeGitHubApiError(args, error));
  }
}

function sanitizeGitHubApiError(args: string[], error: unknown): string {
  const stderr = typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr
    : "";
  const apiPath = args.find((arg) => arg.startsWith("/")) ?? "unknown endpoint";
  const methodIndex = args.findIndex((arg) => arg === "-X");
  const method = methodIndex >= 0 ? args[methodIndex + 1] ?? "GET" : "GET";

  if (apiPath.startsWith("/orgs/") && stderr.includes("admin:org_hook")) {
    return "GitHub organization webhooks require the admin:org_hook scope. Run: gh auth refresh -h github.com -s admin:org_hook";
  }

  const detail = sanitizeSecretText(stderr.trim() || (error instanceof Error ? error.message : "unknown error"));
  return `GitHub API ${method} ${apiPath} failed: ${detail}`;
}

function sanitizeSecretText(value: string): string {
  return value
    .replace(/config\[secret\]=\S+/g, "config[secret]=[redacted]")
    .replace(/-f\s+config\[secret\]=\S+/g, "-f config[secret]=[redacted]");
}
