import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PathContext, RouterConfig } from "./types.js";

const APP_NAME = "codex-github-router";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function configDir({ env = process.env, platform = process.platform, homedir }: PathContext = {}): string {
  const home = homedir ?? env.HOME ?? os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_NAME);
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_NAME);
}

export function cacheDir({ env = process.env, platform = process.platform, homedir }: PathContext = {}): string {
  const home = homedir ?? env.HOME ?? os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", APP_NAME);
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), APP_NAME);
  }
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), APP_NAME);
}

export function configPath(context: PathContext = {}): string {
  return path.join(configDir(context), "config.json");
}

export async function readConfig(context: PathContext = {}): Promise<RouterConfig | null> {
  try {
    const raw = await fs.readFile(configPath(context), "utf8");
    return JSON.parse(raw) as RouterConfig;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeConfig(config: RouterConfig, context: PathContext = {}): Promise<void> {
  const target = configPath(context);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(target, 0o600);
}

export async function clearLocalState(context: PathContext = {}): Promise<void> {
  await Promise.allSettled([
    fs.rm(configDir(context), { recursive: true, force: true }),
    fs.rm(cacheDir(context), { recursive: true, force: true }),
  ]);
}

export function sanitizeConfig(config: RouterConfig | null): RouterConfig | null {
  if (!config) {
    return null;
  }
  return {
    version: config.version,
    publicWebhookUrl: sanitizeUrl(config.publicWebhookUrl),
    localWebhookUrl: sanitizeUrl(config.localWebhookUrl),
    setupRequired: Boolean(config.setupRequired),
    mode: config.mode,
    attachedToExistingTunnel: Boolean(config.attachedToExistingTunnel),
    repositories: sanitizeTargets(config.repositories),
    organizations: sanitizeTargets(config.organizations),
    hasStoredSecrets: Boolean(config.hasStoredSecrets),
  };
}

function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function sanitizeTargets(targets: unknown[] | undefined): unknown[] {
  return (targets ?? []).map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return {};
    }
    const record = target as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    if (typeof record.fullName === "string") sanitized.fullName = record.fullName;
    if (typeof record.login === "string") sanitized.login = record.login;
    if (typeof record.hookId === "number" || typeof record.hookId === "string") sanitized.hookId = record.hookId;
    if (typeof record.enabled === "boolean") sanitized.enabled = record.enabled;
    if (typeof record.issueAutomationEnabled === "boolean") sanitized.issueAutomationEnabled = record.issueAutomationEnabled;
    if (typeof record.issueAutomationLabel === "string") sanitized.issueAutomationLabel = record.issueAutomationLabel;
    if (typeof record.issueAutomationPrompt === "string") sanitized.issueAutomationPrompt = record.issueAutomationPrompt;
    return sanitized;
  });
}
