import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_EXCERPT_LENGTH = 500;

type ExecFile = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

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
  reason?: string | undefined;
}

export interface CodexInboxOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execFile?: ExecFile;
}

export async function deliverToCodexInbox(event: CodexInboxEvent, options: CodexInboxOptions): Promise<CodexInboxResult> {
  const execFile = options.execFile ?? defaultExecFile;
  const threadId = await findCodexThreadId(options, execFile);
  if (!threadId) {
    return { delivered: false, reason: "no matching Codex thread found" };
  }

  const inboxDb = codexInboxDbPath(options.env);
  const notification = buildCodexInboxNotification(event);
  await execFile("sqlite3", [
    inboxDb,
    `insert or replace into inbox_items (id, title, description, thread_id, read_at, created_at) values (${[
      sqlString(randomUUID()),
      sqlString(notification.title),
      sqlString(notification.description),
      sqlString(threadId),
      "null",
      String(Date.now()),
    ].join(", ")});`,
  ]);
  return { delivered: true, threadId };
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

async function findCodexThreadId(options: CodexInboxOptions, execFile: ExecFile): Promise<string | null> {
  const explicitThreadId = options.env.CODEX_THREAD_ID;
  if (explicitThreadId) {
    return explicitThreadId;
  }

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

function codexInboxDbPath(env: NodeJS.ProcessEnv): string {
  return path.join(codexHome(env), "sqlite", "codex-dev.db");
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex");
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
