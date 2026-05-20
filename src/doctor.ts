import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cacheDir, configDir, readConfig } from "./config.js";

const execFileAsync = promisify(execFile);

async function commandVersion(command: string, args: string[] = ["--version"]): Promise<{ available: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 });
    return { available: true, detail: (stdout || stderr).trim().split("\n")[0] ?? "" };
  } catch (error) {
    const detail = error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : error instanceof Error ? error.message : "unknown error";
    return { available: false, detail };
  }
}

async function ghAuthStatus(): Promise<{ authenticated: boolean; source: string; detail?: string }> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 5000 });
    return { authenticated: true, source: "gh" };
  } catch (error) {
    return { authenticated: false, source: "missing", detail: error instanceof Error && "code" in error && error.code === "ENOENT" ? "gh missing" : "gh auth status failed" };
  }
}

export async function doctor({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const [node, gh, git, codex, ngrok, auth] = await Promise.all([
    commandVersion(process.execPath),
    commandVersion("gh"),
    commandVersion("git"),
    commandVersion("codex"),
    commandVersion("ngrok", ["version"]),
    ghAuthStatus(),
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
    auth,
    config: {
      present: Boolean(config),
      setupRequired: !config,
    },
    secrets: credentialStoreStatus(process.platform),
  };
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
