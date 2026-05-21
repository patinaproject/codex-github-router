import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { cacheDir, configDir, readConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_APP_BUNDLED_APP_SERVER_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const FALLBACK_CODEX_APP_SERVER_BIN = "codex";

async function commandVersion(command: string, args: string[] = ["--version"], env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { env, timeout: 5000 });
    return { available: true, detail: (stdout || stderr).trim().split("\n")[0] ?? "" };
  } catch (error) {
    const detail = error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : error instanceof Error ? error.message : "unknown error";
    return { available: false, detail };
  }
}

async function ghAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<{ authenticated: boolean; source: string; detail?: string }> {
  try {
    await execFileAsync("gh", ["auth", "status"], { env, timeout: 5000 });
    return { authenticated: true, source: "gh" };
  } catch (error) {
    return { authenticated: false, source: "missing", detail: error instanceof Error && "code" in error && error.code === "ENOENT" ? "gh missing" : "gh auth status failed" };
  }
}

export async function doctor({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const appServerBin = resolveCodexAppServerBin(env);
  const [node, gh, git, codex, ngrok, auth] = await Promise.all([
    commandVersion(process.execPath, ["--version"], env),
    commandVersion("gh", ["--version"], env),
    commandVersion("git", ["--version"], env),
    commandVersion(appServerBin, ["--version"], env),
    commandVersion("ngrok", ["version"], env),
    ghAuthStatus(env),
  ]);
  const config = await readConfig({ env });

  return {
    ok: true,
    version: "0.1.0",
    paths: {
      configDir: configDir({ env }),
      cacheDir: cacheDir({ env }),
    },
    tools: { node, gh, git, codex, ngrok },
    appServer: {
      binary: appServerBin,
      transport: "stdio",
      command: `${appServerBin} app-server --listen stdio://`,
    },
    auth,
    config: {
      present: Boolean(config),
      setupRequired: Boolean(config?.setupRequired ?? !config),
    },
    secrets: credentialStoreStatus(process.platform),
  };
}

function resolveCodexAppServerBin(env: NodeJS.ProcessEnv): string {
  if (env.CODEX_APP_SERVER_BIN) {
    return env.CODEX_APP_SERVER_BIN;
  }
  const bundledAppServerBin = env.CODEX_APP_BUNDLED_APP_SERVER_BIN ?? DEFAULT_CODEX_APP_BUNDLED_APP_SERVER_BIN;
  return existsSync(bundledAppServerBin) ? bundledAppServerBin : FALLBACK_CODEX_APP_SERVER_BIN;
}

export async function preflightStartup({
  env = process.env,
  requireTunnel,
}: {
  env?: NodeJS.ProcessEnv;
  requireTunnel: boolean;
}): Promise<void> {
  const report = await doctor({ env });
  const requiredTools: Array<keyof typeof report.tools> = ["node", "gh", "git", "codex"];
  if (requireTunnel) {
    requiredTools.push("ngrok");
  }
  const missingTools = requiredTools.filter((tool) => !report.tools[tool].available);
  const failures = [
    ...missingTools.map((tool) => `${tool}: ${report.tools[tool].detail || "missing"}`),
    ...(report.auth.authenticated ? [] : [`gh auth: ${report.auth.detail ?? "not authenticated"}`]),
  ];
  if (failures.length > 0) {
    throw new Error(`Preflight failed before changing GitHub webhooks: ${failures.join("; ")}`);
  }
}

export function credentialStoreStatus(platform: NodeJS.Platform = process.platform): { available: boolean; source: string; detail?: string } {
  if (platform === "darwin") {
    return { available: true, source: "security" };
  }
  if (platform === "win32") {
    return { available: true, source: "cmdkey" };
  }
  return {
    available: false,
    source: "missing",
    detail: "install a freedesktop secret-service provider before storing webhook secrets",
  };
}
