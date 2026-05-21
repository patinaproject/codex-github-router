import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_EXCERPT_LENGTH = 500;
const DEFAULT_CODEX_APP_SERVER_BIN = "codex";
const DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_SESSION_SCAN_DAYS = 14;

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
  reason?: string | undefined;
}

export interface CodexInboxOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execFile?: ExecFile;
  spawnProcess?: SpawnProcess;
}

export async function deliverToCodexInbox(event: CodexInboxEvent, options: CodexInboxOptions): Promise<CodexInboxResult> {
  const execFile = options.execFile ?? defaultExecFile;
  const thread = await findCodexThread(event, options, execFile);
  if (!thread.threadId) {
    return { delivered: false, reason: thread.reason ?? "no matching Codex thread found" };
  }

  const notification = buildCodexInboxNotification(event);
  const turnId = await startCodexTurn({
    env: options.env,
    message: notification.description,
    spawnProcess: options.spawnProcess ?? defaultSpawnProcess,
    threadId: thread.threadId,
  });
  return { delivered: true, threadId: thread.threadId, turnId };
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
  const explicitThreadId = options.env.CODEX_THREAD_ID;
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
  env,
  message,
  spawnProcess,
  threadId,
}: {
  env: NodeJS.ProcessEnv;
  message: string;
  spawnProcess: SpawnProcess;
  threadId: string;
}): Promise<string> {
  const codexBin = env.CODEX_APP_SERVER_BIN ?? DEFAULT_CODEX_APP_SERVER_BIN;
  const timeoutMs = Number(env.CODEX_APP_SERVER_TIMEOUT_MS ?? DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS);
  const child = spawnProcess(codexBin, ["app-server", "--listen", "stdio://"], {
    env: {
      ...env,
      PATH: env.PATH ? `/opt/homebrew/bin:/usr/local/bin:${env.PATH}` : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TERM: env.TERM ?? "xterm-256color",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let resumed = false;
  let settled = false;
  let compacting = false;
  let retriedAfterCompaction = false;
  let turnId: string | null = null;
  const pendingRequests = new Map<string, string>();

  function request(method: string, params: Record<string, unknown> = {}): void {
    const id = String(nextId);
    nextId += 1;
    pendingRequests.set(id, method);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  function notify(method: string, params: Record<string, unknown> = {}): void {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  function requestTurnStart(): void {
    request("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: message,
        text_elements: [],
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

    function resolveOnce(startedTurnId: string): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(startedTurnId);
    }

    function shutdown(): void {
      child.stdin.end();
      child.kill("SIGTERM");
    }

    const timeout = setTimeout(() => {
      rejectOnce(new Error(`Timed out waiting for Codex app-server turn start after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      rejectOnce(error);
    });
    child.once("exit", (code) => {
      if (!settled) {
        rejectOnce(new Error(`Codex app-server exited before starting a turn with code ${code ?? "unknown"}`));
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (const body of takeJsonMessages()) {
        handleMessageBody(body);
      }
    });
    child.stderr.on("data", () => {});

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

      if (responseMethod === "initialize") {
        notify("initialized");
        request("thread/resume", { threadId, excludeTurns: true });
        return;
      }

      const result = objectField(messageJson, "result");
      const thread = objectField(result, "thread");
      if (stringField(thread, "id") === threadId && !resumed) {
        resumed = true;
        requestTurnStart();
        return;
      }

      if (messageJson.method === "thread/compacted") {
        const params = objectField(messageJson, "params");
        if (compacting && stringField(params, "threadId") === threadId) {
          compacting = false;
          retriedAfterCompaction = true;
          turnId = null;
          requestTurnStart();
        }
        return;
      }

      const turn = objectField(result, "turn");
      const startedTurnId = stringField(turn, "id");
      if (startedTurnId && !turnId) {
        turnId = startedTurnId;
        return;
      }

      if (messageJson.method === "turn/completed") {
        const params = objectField(messageJson, "params");
        if (stringField(params, "threadId") === threadId) {
          const completedTurn = objectField(params, "turn");
          const completedTurnId = stringField(completedTurn, "id") ?? turnId;
          const status = stringField(completedTurn, "status") ?? "unknown";
          if (!turnId || completedTurnId === turnId) {
            if (status === "failed" && !retriedAfterCompaction && hasContextWindowExceeded(completedTurn)) {
              compacting = true;
              request("thread/compact/start", { threadId });
              return;
            }
            shutdown();
            if (completedTurnId) {
              resolveOnce(completedTurnId);
            } else {
              rejectOnce(new Error(`Codex turn ${completedTurnId ?? "unknown"} completed with status ${status}`));
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
          "item/agentMessage/delta",
          "item/plan/delta",
          "item/fileChange/outputDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
  });
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
