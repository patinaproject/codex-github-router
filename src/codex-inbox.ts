import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_EXCERPT_LENGTH = 500;
const DEFAULT_CODEX_APP_BUNDLED_APP_SERVER_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const FALLBACK_CODEX_APP_SERVER_BIN = "codex";
const DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_SESSION_SCAN_DAYS = 14;
const CODEX_APP_SERVER_STDIO_ARGS = ["app-server", "--listen", "stdio://"] as const;
const activeCodexThreadDeliveries = new Map<string, Promise<void>>();

type ExecFile = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
type AppServerProcess = ChildProcessByStdio<Writable, Readable, Readable>;
type SpawnProcess = (file: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
}) => AppServerProcess;

export interface CodexInboxEvent {
  event: string;
  deliveryId?: string | undefined;
  payload: Record<string, unknown>;
  route: {
    kind: "repository" | "organization";
    name: string;
  };
}

export interface CodexInboxResult {
  delivered: boolean;
  threadId?: string | undefined;
  turnId?: string | undefined;
  agentMessage?: string | undefined;
  appServerBin?: string | undefined;
  appServerVersion?: string | undefined;
  reason?: string | undefined;
}

export interface CodexInboxOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execFile?: ExecFile;
  appServerLog?: ((message: string) => void) | undefined;
  spawnProcess?: SpawnProcess;
}

export async function deliverToCodexInbox(event: CodexInboxEvent, options: CodexInboxOptions): Promise<CodexInboxResult> {
  const execFile = options.execFile ?? defaultExecFile;
  const thread = await findCodexThread(event, options, execFile);
  if (!thread.threadId) {
    return {
      delivered: false,
      reason: thread.reason ?? "no matching Codex thread found",
    };
  }
  const threadId = thread.threadId;

  const notification = buildCodexInboxNotification(event);
  const codexBin = resolveCodexAppServerBin(options.env);
  const codexVersion = options.spawnProcess ? null : await codexAppServerVersion(codexBin, execFile);
  let turn: CodexTurnResult;
  try {
    turn = await runWithCodexThreadDeliveryLock(threadId, () => startCodexTurn({
      codexBin,
      codexVersion,
      env: options.env,
      log: options.appServerLog,
      message: notification.description,
      spawnProcess: options.spawnProcess ?? defaultSpawnProcess,
      threadId,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`thread ${threadId}: ${message}`);
  }

  return {
    delivered: true,
    threadId,
    turnId: turn.turnId,
    ...(turn.agentMessage ? { agentMessage: turn.agentMessage } : {}),
    appServerBin: codexBin,
    ...(codexVersion ? { appServerVersion: codexVersion } : {}),
  };
}

async function runWithCodexThreadDeliveryLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const previous = activeCodexThreadDeliveries.get(threadId) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  activeCodexThreadDeliveries.set(threadId, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (activeCodexThreadDeliveries.get(threadId) === next) {
      activeCodexThreadDeliveries.delete(threadId);
    }
  }
}

export function buildCodexInboxNotification(event: CodexInboxEvent): { title: string; description: string } {
  const repository = repositoryName(event.payload);
  const action = stringField(event.payload, "action");
  const sender = loginField(objectField(event.payload, "sender"));
  const comment = objectField(event.payload, "comment");
  const issue = objectField(event.payload, "issue");
  const pullRequest = objectField(event.payload, "pull_request");
  const url = stringField(comment, "html_url")
    ?? stringField(pullRequest, "html_url")
    ?? stringField(issue, "html_url")
    ?? stringField(event.payload, "html_url");
  const body = stringField(comment, "body") ?? stringField(event.payload, "body");

  const lines = [
    `Received ${event.event} delivery ${event.deliveryId ?? "unknown"} for ${repository}; using ${event.route.kind} settings ${event.route.name}.`,
    action ? `Action: ${action}` : undefined,
    sender ? `Sender: ${sender}` : undefined,
    body ? `Comment: ${excerpt(body)}` : undefined,
    url ? `URL: ${url}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return {
    title: `GitHub ${event.event} for ${repository}`,
    description: lines.join("\n"),
  };
}

async function findCodexThread(event: CodexInboxEvent, options: CodexInboxOptions, execFile: ExecFile): Promise<{ threadId: string | null; reason?: string }> {
  const explicitThreadId = options.env.CODEX_GITHUB_ROUTER_THREAD_ID;
  if (explicitThreadId) {
    return { threadId: explicitThreadId };
  }

  const prSession = await findPrSessionThread(event, options, execFile);
  if (prSession) {
    return prSession;
  }

  return { threadId: await findCodexThreadIdFromState(options, execFile) };
}

async function findCodexThreadIdFromState(options: CodexInboxOptions, execFile: ExecFile): Promise<string | null> {
  const stateDb = codexStateDbPath(options.env);
  const branch = await currentBranch(options.cwd, execFile);
  const orderByBranch = branch ? `case when git_branch = ${sqlString(branch)} then 0 else 1 end, ` : "";
  const query = [
    "select id from threads",
    `where cwd = ${sqlString(options.cwd)} and archived = 0`,
    `order by ${orderByBranch}updated_at desc`,
    "limit 1;",
  ].join(" ");
  const result = await execFile("sqlite3", [stateDb, query]);
  const threadId = result.stdout.trim().split(/\r?\n/u)[0];
  return threadId || null;
}

async function findPrSessionThread(event: CodexInboxEvent, options: CodexInboxOptions, execFile: ExecFile): Promise<{ threadId: string | null; reason?: string } | null> {
  const repo = repositoryName(event.payload);
  const prNumber = pullRequestNumber(event.payload);
  if (!repo || repo === "unknown repository" || !prNumber) {
    return null;
  }

  const headRef = await pullRequestHeadRef(event.payload, repo, prNumber, execFile);
  if (!headRef) {
    return { threadId: null, reason: `pull request head branch not found for ${repo}#${prNumber}` };
  }

  const sessions = await recentCodexSessions(options.env);
  const inspected = (await Promise.all(sessions.map((session) => inspectCodexSession(session, execFile)))).filter((session): session is CodexGitSession => Boolean(session));
  const matches = inspected
    .filter((session) => session.repo === repo.toLowerCase() && session.branch === headRef)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (matches.length === 0) {
    return { threadId: null, reason: `no Codex session found for ${repo}#${prNumber} on branch ${headRef}` };
  }

  const cwds = new Set(matches.map((match) => match.cwd));
  if (cwds.size > 1) {
    return { threadId: null, reason: `ambiguous Codex sessions for ${repo}#${prNumber} on branch ${headRef}` };
  }

  return { threadId: matches[0]?.threadId ?? null };
}

interface CodexSession {
  threadId: string;
  cwd: string;
  mtimeMs: number;
}

interface CodexGitSession extends CodexSession {
  repo: string;
  branch: string;
}

interface CodexTurnResult {
  turnId: string;
  agentMessage?: string | undefined;
}

async function recentCodexSessions(env: NodeJS.ProcessEnv): Promise<CodexSession[]> {
  const root = codexSessionsRoot(env);
  const scanDays = Number(env.CODEX_SESSION_SCAN_DAYS ?? DEFAULT_CODEX_SESSION_SCAN_DAYS);
  const cutoff = Date.now() - scanDays * 24 * 60 * 60 * 1000;
  const files = await walkJsonlFiles(root);
  const sessions: CodexSession[] = [];
  await Promise.all(files.map(async (file) => {
    try {
      const fileStat = await stat(file);
      if (fileStat.mtimeMs < cutoff) {
        return;
      }
      const session = await readCodexSession(file);
      if (session) {
        sessions.push({ ...session, mtimeMs: fileStat.mtimeMs });
      }
    } catch {
      return;
    }
  }));
  return sessions;
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }));
  }

  await visit(root);
  return files;
}

async function readCodexSession(file: string): Promise<Omit<CodexSession, "mtimeMs"> | null> {
  const raw = await readFile(file, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.includes('"type":"session_meta"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const payload = objectField(parsed, "payload");
      const threadId = stringField(payload, "id");
      const cwd = stringField(payload, "cwd");
      if (threadId && cwd && !isSubagentSession(payload)) {
        return { threadId, cwd };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function isSubagentSession(payload: Record<string, unknown> | undefined): boolean {
  if (stringField(payload, "thread_source") === "subagent") {
    return true;
  }
  return Boolean(objectField(objectField(payload, "source"), "subagent"));
}

async function inspectCodexSession(session: CodexSession, execFile: ExecFile): Promise<CodexGitSession | null> {
  try {
    const [remote, branch] = await Promise.all([
      execFile("git", ["-C", session.cwd, "remote", "get-url", "origin"]),
      execFile("git", ["-C", session.cwd, "branch", "--show-current"]),
    ]);
    const repo = normalizeGitHubRepo(remote.stdout.trim());
    const branchName = branch.stdout.trim();
    if (!repo || !branchName) {
      return null;
    }
    return { ...session, repo, branch: branchName };
  } catch {
    return null;
  }
}

async function pullRequestHeadRef(payload: Record<string, unknown>, repo: string, prNumber: number, execFile: ExecFile): Promise<string | null> {
  const pullRequest = objectField(payload, "pull_request");
  const head = objectField(pullRequest, "head");
  const payloadHeadRef = stringField(head, "ref");
  if (payloadHeadRef) {
    return payloadHeadRef;
  }
  try {
    const result = await execFile("gh", ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.ref"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function pullRequestNumber(payload: Record<string, unknown>): number | null {
  const pullRequest = objectField(payload, "pull_request");
  const pullRequestNumberValue = numberField(pullRequest, "number");
  if (pullRequestNumberValue) {
    return pullRequestNumberValue;
  }

  const issue = objectField(payload, "issue");
  if (objectField(issue, "pull_request")) {
    return numberField(issue, "number") ?? null;
  }
  return null;
}

function normalizeGitHubRepo(value: string): string | null {
  const normalized = value.trim();
  const sshMatch = normalized.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u);
  if (sshMatch?.[1]) {
    return sshMatch[1].toLowerCase();
  }

  const httpsMatch = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/u);
  if (httpsMatch?.[1]) {
    return httpsMatch[1].toLowerCase();
  }

  const plainMatch = normalized.match(/^([^/]+\/[^/]+?)(?:\.git)?$/u);
  if (plainMatch?.[1]) {
    return plainMatch[1].toLowerCase();
  }

  return null;
}

async function currentBranch(cwd: string, execFile: ExecFile): Promise<string | null> {
  try {
    const result = await execFile("git", ["-C", cwd, "branch", "--show-current"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function defaultExecFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, [...args], { maxBuffer: 1024 * 1024 });
  return { stdout, stderr };
}

function codexStateDbPath(env: NodeJS.ProcessEnv): string {
  return path.join(codexHome(env), "state_5.sqlite");
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex");
}

function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  return env.CODEX_SESSIONS_ROOT ?? path.join(codexHome(env), "sessions");
}

function startCodexTurn({
  codexBin,
  codexVersion,
  env,
  log,
  message,
  spawnProcess,
  threadId,
}: {
  codexBin: string;
  codexVersion: string | null;
  env: NodeJS.ProcessEnv;
  log?: ((message: string) => void) | undefined;
  message: string;
  spawnProcess: SpawnProcess;
  threadId: string;
}): Promise<CodexTurnResult> {
  const appServerTransportArgs = CODEX_APP_SERVER_STDIO_ARGS;
  const appServerCommand = `${codexBin} ${appServerTransportArgs.join(" ")}`;
  const appServerLabel = `Codex app-server ${appServerCommand}${codexVersion ? ` (${codexVersion})` : ""}`;
  const timeoutMs = Number(env.CODEX_APP_SERVER_TIMEOUT_MS ?? DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS);
  logAppServer(log, `using ${codexBin}${codexVersion ? ` (${codexVersion})` : ""}`);
  logAppServer(log, appServerTransportMessage(appServerTransportArgs));
  logAppServer(log, `spawn ${appServerCommand}`);
  const child = spawnProcess(codexBin, appServerTransportArgs, {
    env: codexAppServerEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let stderrBuffer = "";
  let resumed = false;
  let settled = false;
  let compacting = false;
  let waitingForActiveTurn = false;
  let retriedAfterCompaction = false;
  let turnId: string | null = null;
  let agentMessage = "";
  const pendingRequests = new Map<string, string>();

  function request(method: string, params: Record<string, unknown> = {}): void {
    const id = String(nextId);
    nextId += 1;
    pendingRequests.set(id, method);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    logAppServer(log, `-> request ${method} id=${id}${summarizeAppServerParams(params)}`);
  }

  function notify(method: string, params: Record<string, unknown> = {}): void {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    logAppServer(log, `-> notification ${method}${summarizeAppServerParams(params)}`);
  }

  function requestTurnStart(): void {
    waitingForActiveTurn = false;
    request("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: message,
      }],
    });
  }

  return new Promise((resolve, reject) => {
    function rejectOnce(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      reject(error);
    }

    function resolveOnce(result: CodexTurnResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    function shutdown(): void {
      child.stdin.end();
      child.kill("SIGTERM");
    }

    const timeout = setTimeout(() => {
      rejectOnce(new Error(`Timed out waiting for ${appServerLabel} turn completion after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      rejectOnce(error);
    });
    child.once("exit", (code) => {
      if (!settled) {
        rejectOnce(appServerExitError({ appServerLabel, code, stderr: stderrBuffer }));
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (const body of takeJsonMessages()) {
        handleMessageBody(body);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const stderr = chunk.toString("utf8");
      stderrBuffer = `${stderrBuffer}${stderr}`;
      logAppServer(log, `stderr: ${excerpt(stderr)}`);
      if (isCodexAppServerAuthFailure(stderrBuffer)) {
        rejectOnce(codexAppServerAuthError());
      }
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
          rejectOnce(new Error(`Missing Content-Length header: ${header}`));
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

    function handleMessageBody(body: string): void {
      let messageJson: Record<string, unknown>;
      try {
        messageJson = JSON.parse(body) as Record<string, unknown>;
      } catch {
        rejectOnce(new Error(`Failed to parse Codex app-server JSON: ${body}`));
        return;
      }

      if (messageJson.error) {
        rejectOnce(new Error(JSON.stringify(messageJson.error)));
        return;
      }

      const id = typeof messageJson.id === "string" || typeof messageJson.id === "number" ? String(messageJson.id) : null;
      const responseMethod = id ? pendingRequests.get(id) : null;
      if (id) {
        pendingRequests.delete(id);
      }
      if (responseMethod) {
        logAppServer(log, `<- response id=${id ?? "unknown"} for ${responseMethod}${summarizeAppServerResult(messageJson)}`);
      } else if (typeof messageJson.method === "string") {
        logAppServer(log, `<- notification ${messageJson.method}${summarizeAppServerNotification(messageJson)}`);
      }

      if (responseMethod === "initialize") {
        notify("initialized");
        request("thread/resume", { threadId, excludeTurns: true });
        return;
      }

      const result = objectField(messageJson, "result");
      const thread = objectField(result, "thread");
      if (stringField(thread, "id") === threadId && !resumed) {
        resumed = true;
        const status = objectField(thread, "status");
        if (stringField(status, "type") === "active") {
          waitingForActiveTurn = true;
          logAppServer(log, `thread ${threadId} is active; queueing delivery until the active turn completes`);
          return;
        }
        requestTurnStart();
        return;
      }

      if (messageJson.method === "thread/compacted") {
        const params = objectField(messageJson, "params");
        if (compacting && stringField(params, "threadId") === threadId) {
          compacting = false;
          retriedAfterCompaction = true;
          turnId = null;
          agentMessage = "";
          requestTurnStart();
        }
        return;
      }

      if (messageJson.method === "item/agentMessage/delta") {
        const params = objectField(messageJson, "params");
        if (stringField(params, "threadId") === threadId && stringField(params, "turnId") === turnId) {
          agentMessage = `${agentMessage}${stringField(params, "delta") ?? ""}`;
        }
        return;
      }

      const turn = objectField(result, "turn");
      const startedTurnId = stringField(turn, "id");
      if (startedTurnId && !turnId) {
        turnId = startedTurnId;
        logAppServer(log, `turn started ${startedTurnId}`);
        return;
      }

      if (messageJson.method === "turn/completed") {
        const params = objectField(messageJson, "params");
        if (stringField(params, "threadId") === threadId) {
          const completedTurn = objectField(params, "turn");
          const completedTurnId = stringField(completedTurn, "id") ?? turnId;
          const status = stringField(completedTurn, "status") ?? "unknown";
          if (waitingForActiveTurn && !turnId) {
            logAppServer(log, `active turn completed ${completedTurnId ?? "unknown"} status=${status}; starting queued delivery`);
            requestTurnStart();
            return;
          }
          if (turnId && completedTurnId === turnId) {
            logAppServer(log, `turn completed ${completedTurnId ?? "unknown"} status=${status}`);
            if (status === "failed" && !retriedAfterCompaction && hasContextWindowExceeded(completedTurn)) {
              compacting = true;
              request("thread/compact/start", { threadId });
              return;
            }
            shutdown();
            if (completedTurnId && status === "completed") {
              const trimmedAgentMessage = agentMessage.trim();
              if (trimmedAgentMessage) {
                logAppServer(log, `agent response: ${excerpt(trimmedAgentMessage)}`);
              }
              resolveOnce({
                turnId: completedTurnId,
                ...(trimmedAgentMessage ? { agentMessage: trimmedAgentMessage } : {}),
              });
            } else {
              rejectOnce(new Error(`${appServerLabel} turn ${completedTurnId ?? "unknown"} completed with status ${status}${turnErrorDetails(completedTurn)}`));
            }
          }
        }
      }
    }

    request("initialize", {
      clientInfo: {
        name: "codex-github-router",
        title: "Codex GitHub Router",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/plan/delta",
          "item/fileChange/outputDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
  });
}

function resolveCodexAppServerBin(env: NodeJS.ProcessEnv): string {
  if (env.CODEX_APP_SERVER_BIN) {
    return env.CODEX_APP_SERVER_BIN;
  }

  const bundledAppServerBin = env.CODEX_APP_BUNDLED_APP_SERVER_BIN ?? DEFAULT_CODEX_APP_BUNDLED_APP_SERVER_BIN;
  return existsSync(bundledAppServerBin) ? bundledAppServerBin : FALLBACK_CODEX_APP_SERVER_BIN;
}

function appServerTransportMessage(_appServerTransportArgs: readonly string[]): string {
  return "opened app-server transport: stdio";
}

async function codexAppServerVersion(codexBin: string, execFile: ExecFile): Promise<string | null> {
  try {
    const result = await execFile(codexBin, ["--version"]);
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

function codexAppServerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: env.PATH ? `/opt/homebrew/bin:/usr/local/bin:${env.PATH}` : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TERM: env.TERM ?? "xterm-256color",
  };
  delete nextEnv.CODEX_THREAD_ID;
  return nextEnv;
}

function turnErrorDetails(turn: Record<string, unknown> | undefined): string {
  const error = objectField(turn, "error");
  if (!error) {
    return "";
  }
  return `: ${excerpt(JSON.stringify(error))}`;
}

function appServerExitError({ appServerLabel, code, stderr }: { appServerLabel: string; code: number | null; stderr: string }): Error {
  if (isCodexAppServerAuthFailure(stderr)) {
    return codexAppServerAuthError();
  }
  return new Error(`${appServerLabel} exited before starting a turn with code ${code ?? "unknown"}${stderr ? `: ${excerpt(stderr)}` : ""}`);
}

function isCodexAppServerAuthFailure(stderr: string): boolean {
  return /TokenRefreshFailed|invalid_grant|Invalid refresh token/iu.test(stderr);
}

function codexAppServerAuthError(): Error {
  return new Error("Codex app-server authentication failed: refresh token is invalid or expired. Sign in to Codex again, then retry.");
}

function logAppServer(log: ((message: string) => void) | undefined, message: string): void {
  log?.(`[codex-app-server] ${message}`);
}

function summarizeAppServerParams(params: Record<string, unknown>): string {
  const details: string[] = [];
  const threadId = stringField(params, "threadId");
  if (threadId) {
    details.push(`thread=${threadId}`);
  }
  const turnId = stringField(params, "turnId");
  if (turnId) {
    details.push(`turn=${turnId}`);
  }
  const input = params.input;
  if (Array.isArray(input)) {
    details.push(`input=${input.length} item${input.length === 1 ? "" : "s"}`);
  }
  return details.length > 0 ? ` ${details.join(" ")}` : "";
}

function summarizeAppServerResult(messageJson: Record<string, unknown>): string {
  const result = objectField(messageJson, "result");
  const thread = objectField(result, "thread");
  const turn = objectField(result, "turn");
  const details: string[] = [];
  const threadId = stringField(thread, "id");
  if (threadId) {
    details.push(`thread=${threadId}`);
  }
  const turnId = stringField(turn, "id");
  if (turnId) {
    details.push(`turn=${turnId}`);
  }
  return details.length > 0 ? ` ${details.join(" ")}` : "";
}

function summarizeAppServerNotification(messageJson: Record<string, unknown>): string {
  const params = objectField(messageJson, "params");
  const turn = objectField(params, "turn");
  const details: string[] = [];
  const threadId = stringField(params, "threadId");
  if (threadId) {
    details.push(`thread=${threadId}`);
  }
  const turnId = stringField(turn, "id") ?? stringField(params, "turnId");
  if (turnId) {
    details.push(`turn=${turnId}`);
  }
  const status = stringField(turn, "status");
  if (status) {
    details.push(`status=${status}`);
  }
  return details.length > 0 ? ` ${details.join(" ")}` : "";
}

function defaultSpawnProcess(file: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
}): AppServerProcess {
  return nodeSpawn(file, [...args], options);
}

function repositoryName(payload: Record<string, unknown>): string {
  const repository = objectField(payload, "repository");
  return stringField(repository, "full_name") ?? "unknown repository";
}

function objectField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function hasContextWindowExceeded(turn: Record<string, unknown> | undefined): boolean {
  const error = objectField(turn, "error");
  const codexErrorInfo = error?.codexErrorInfo;
  return codexErrorInfo === "contextWindowExceeded";
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function loginField(value: Record<string, unknown> | undefined): string | undefined {
  return stringField(value, "login");
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= DEFAULT_EXCERPT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, DEFAULT_EXCERPT_LENGTH - 3)}...`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}
