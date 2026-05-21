import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cacheDir, configDir, readConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_APP_BUNDLED_APP_SERVER_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const FALLBACK_CODEX_APP_SERVER_BIN = "codex";
const CODEX_APP_SERVER_CONTROL_SOCKET_ENV = "CODEX_APP_SERVER_CONTROL_SOCKET";
const DEFAULT_APP_SERVER_PROBE_TIMEOUT_MS = 1000;

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
  const appServer = await appServerReadiness(appServerBin, env);

  return {
    ok: true,
    version: "0.1.0",
    paths: {
      configDir: configDir({ env }),
      cacheDir: cacheDir({ env }),
    },
    tools: { node, gh, git, codex, ngrok },
    appServer,
    auth,
    config: {
      present: Boolean(config),
      setupRequired: Boolean(config?.setupRequired ?? !config),
    },
    secrets: credentialStoreStatus(process.platform),
  };
}

async function appServerReadiness(codexBin: string, env: NodeJS.ProcessEnv) {
  const [desktop, daemon] = await Promise.all([
    processStatus(["-f", "Codex.app"], env),
    commandVersion(codexBin, ["app-server", "daemon", "--help"], env),
  ]);
  const controlSockets = await Promise.all(controlSocketCandidates(env).map(async (candidate) => {
    const exists = existsSync(candidate.path);
    if (!exists) {
      return { ...candidate, exists, protocol: "missing" };
    }
    const probe = await probeControlSocket({ codexBin, env, socketPath: candidate.path, threadId: env.CODEX_GITHUB_ROUTER_THREAD_ID });
    return { ...candidate, exists, ...probe };
  }));
  const responsiveSockets = controlSockets.filter((socket) => socket.protocol === "ok");
  const loadedTarget = env.CODEX_GITHUB_ROUTER_THREAD_ID
    ? responsiveSockets.some((socket) => "targetThreadLoaded" in socket && socket.targetThreadLoaded === true)
    : undefined;
  return {
    binary: codexBin,
    desktop: {
      running: desktop.available,
      detail: desktop.detail,
    },
    managedDaemon: {
      available: daemon.available,
      detail: daemon.detail,
    },
    controlSockets,
    targetThread: env.CODEX_GITHUB_ROUTER_THREAD_ID
      ? {
          id: env.CODEX_GITHUB_ROUTER_THREAD_ID,
          loaded: responsiveSockets.length > 0 ? loadedTarget : "unverified",
          detail: responsiveSockets.length > 0
            ? "loaded status proved through app-server thread/loaded/list"
            : "no candidate control socket answered the app-server protocol",
        }
      : {
          loaded: "unknown",
          detail: "set CODEX_GITHUB_ROUTER_THREAD_ID or route a PR event to resolve a target thread",
        },
  };
}

function probeControlSocket({
  codexBin,
  env,
  socketPath,
  threadId,
}: {
  codexBin: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  threadId?: string | undefined;
}): Promise<{ protocol: string; detail: string; targetThreadLoaded?: boolean | undefined }> {
  const timeoutMs = Number(env.CODEX_APP_SERVER_PROBE_TIMEOUT_MS ?? DEFAULT_APP_SERVER_PROBE_TIMEOUT_MS);
  const child = nodeSpawn(codexBin, ["app-server", "proxy", "--sock", socketPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = Buffer.alloc(0);
  let stderrBuffer = "";
  let settled = false;
  const pendingRequests = new Map<string, string>([["1", "initialize"]]);

  function writeJson(value: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  return new Promise((resolve) => {
    function settle(result: { protocol: string; detail: string; targetThreadLoaded?: boolean | undefined }): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      resolve(result);
    }

    const timeout = setTimeout(() => {
      settle({ protocol: "timeout", detail: `no app-server initialize response within ${timeoutMs}ms` });
    }, timeoutMs);

    child.once("error", (error) => {
      settle({ protocol: "unsupported", detail: error.message });
    });
    child.once("exit", (code) => {
      if (!settled) {
        settle({ protocol: "unsupported", detail: `proxy exited with code ${code ?? "unknown"}${stderrBuffer ? `: ${excerpt(stderrBuffer)}` : ""}` });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (const body of takeJsonMessages()) {
        handleProbeMessage(body);
      }
    });

    writeJson({
      id: "1",
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-github-router",
          title: "Codex GitHub Router",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });

    function takeJsonMessages(): string[] {
      const messages: string[] = [];
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) {
            return messages;
          }
          const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            messages.push(line);
          }
          continue;
        }

        const header = buffer.slice(0, headerEnd).toString("ascii");
        const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/iu);
        if (!contentLengthMatch?.[1]) {
          settle({ protocol: "unsupported", detail: `missing Content-Length header: ${header}` });
          return messages;
        }
        const contentLength = Number(contentLengthMatch[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) {
          return messages;
        }
        messages.push(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
        buffer = buffer.slice(bodyEnd);
      }
    }

    function handleProbeMessage(body: string): void {
      let messageJson: Record<string, unknown>;
      try {
        messageJson = JSON.parse(body) as Record<string, unknown>;
      } catch {
        settle({ protocol: "unsupported", detail: "non-JSON app-server response" });
        return;
      }
      if (messageJson.error) {
        settle({ protocol: "unsupported", detail: excerpt(JSON.stringify(messageJson.error)) });
        return;
      }
      const id = typeof messageJson.id === "string" || typeof messageJson.id === "number" ? String(messageJson.id) : null;
      const method = id ? pendingRequests.get(id) : null;
      if (id) {
        pendingRequests.delete(id);
      }
      if (method === "initialize") {
        writeJson({ method: "initialized", params: {} });
        if (!threadId) {
          settle({ protocol: "ok", detail: "initialize response received" });
          return;
        }
        pendingRequests.set("2", "thread/loaded/list");
        writeJson({ id: "2", method: "thread/loaded/list", params: {} });
        return;
      }
      if (method === "thread/loaded/list") {
        const result = objectField(messageJson, "result");
        const loadedThreadIds = result?.data;
        settle({
          protocol: "ok",
          detail: "initialize and thread/loaded/list responses received",
          targetThreadLoaded: Array.isArray(loadedThreadIds) && loadedThreadIds.includes(threadId),
        });
      }
    }
  });
}

async function processStatus(args: string[], env: NodeJS.ProcessEnv): Promise<{ available: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync("pgrep", args, { env, timeout: 5000 });
    return { available: stdout.trim().length > 0, detail: stdout.trim() ? "running" : "not running" };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === 1) {
      return { available: false, detail: "not running" };
    }
    return { available: false, detail: error instanceof Error ? error.message : "unknown error" };
  }
}

function resolveCodexAppServerBin(env: NodeJS.ProcessEnv): string {
  if (env.CODEX_APP_SERVER_BIN) {
    return env.CODEX_APP_SERVER_BIN;
  }
  const bundledAppServerBin = env.CODEX_APP_BUNDLED_APP_SERVER_BIN ?? DEFAULT_CODEX_APP_BUNDLED_APP_SERVER_BIN;
  return existsSync(bundledAppServerBin) ? bundledAppServerBin : FALLBACK_CODEX_APP_SERVER_BIN;
}

function controlSocketCandidates(env: NodeJS.ProcessEnv): Array<{ source: string; path: string }> {
  const candidates: Array<{ source: string; path: string }> = [];
  const configuredSocket = env[CODEX_APP_SERVER_CONTROL_SOCKET_ENV];
  if (configuredSocket) {
    candidates.push({ source: CODEX_APP_SERVER_CONTROL_SOCKET_ENV, path: configuredSocket });
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  candidates.push({ source: "default-temp", path: path.join(os.tmpdir(), "codex-ipc", `ipc-${uid}.sock`) });
  return candidates;
}

function objectField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
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
