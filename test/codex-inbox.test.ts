import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildCodexInboxNotification, deliverToCodexInbox } from "../src/codex-inbox.js";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const MISSING_APP_SERVER_CONTROL_SOCKET = path.join(os.tmpdir(), "missing-codex-app-server-control.sock");

function envWithoutAppServerControlSocket(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { CODEX_APP_SERVER_CONTROL_SOCKET: MISSING_APP_SERVER_CONTROL_SOCKET, ...env };
}

function createAppServerProcess(): ChildProcessByStdio<Writable, Readable, Readable> & { stdinLines: string[]; killedSignals: string[] } {
  const child = new EventEmitter() as ChildProcessByStdio<Writable, Readable, Readable> & { stdinLines: string[]; killedSignals: string[] };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinLines: string[] = [];
  const killedSignals: string[] = [];
  stdin.on("data", (chunk) => {
    stdinLines.push(...chunk.toString("utf8").trim().split(/\n/u).filter(Boolean));
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdinLines = stdinLines;
  child.killedSignals = killedSignals;
  child.kill = (signal?: NodeJS.Signals | number) => {
      killedSignals.push(String(signal));
      stdout.end();
      stderr.end();
      stdin.end();
      return true;
  };
  return child;
}

async function writeAppServerResponses(child: ReturnType<typeof createAppServerProcess>, threadId: string, turnId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { thread: { id: threadId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { turn: { id: turnId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })}\n`);
}

async function writeLiveAppServerResponses(child: ReturnType<typeof createAppServerProcess>, threadId: string, turnId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { data: [threadId] } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { thread: { id: threadId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "4", result: { turn: { id: turnId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })}\n`);
}

async function writeLiveThreadMissingResponses(child: ReturnType<typeof createAppServerProcess>): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { data: ["other-thread"] } })}\n`);
}

async function writeLiveTurnFailureAfterProof(child: ReturnType<typeof createAppServerProcess>, threadId: string, turnId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { data: [threadId] } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { thread: { id: threadId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "4", result: { turn: { id: turnId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed" } } })}\n`);
}

async function writeAppServerResponsesWithAgentMessage(child: ReturnType<typeof createAppServerProcess>, threadId: string, turnId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { thread: { id: threadId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { turn: { id: turnId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "item-1", delta: "Acknowledged. " } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "item-1", delta: "No follow-up needed." } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })}\n`);
}

async function writeFailedAppServerTurn(child: ReturnType<typeof createAppServerProcess>, threadId: string, turnId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { thread: { id: threadId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { turn: { id: turnId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed" } } })}\n`);
}

async function writeActiveTurnQueueResponses(child: ReturnType<typeof createAppServerProcess>, threadId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    id: "2",
    result: {
      thread: {
        id: threadId,
        status: { type: "active" },
        turns: [{ id: "turn-active", status: "inProgress" }],
      },
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn-active", status: "completed" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { turn: { id: "turn-queued" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn-queued", status: "completed" } } })}\n`);
}

async function writeCompactedRetryAppServerTurn(child: ReturnType<typeof createAppServerProcess>, threadId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "2", result: { thread: { id: threadId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "3", result: { turn: { id: "turn-full" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: "turn-full",
        status: "failed",
        error: {
          message: "context window exceeded",
          codexErrorInfo: "contextWindowExceeded",
          additionalDetails: null,
        },
      },
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "4", result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "thread/compacted", params: { threadId, turnId: "compact-turn" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ id: "5", result: { turn: { id: "turn-retry" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn-retry", status: "completed" } } })}\n`);
}

test("builds a Codex inbox notification from an issue comment delivery", () => {
  const notification = buildCodexInboxNotification({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      action: "created",
      repository: { full_name: "patinaproject/codex-github-router" },
      sender: { login: "tlmader" },
      comment: {
        body: "leave a test comment on our PR",
        html_url: "https://github.com/patinaproject/codex-github-router/pull/4#issuecomment-1",
      },
    },
  });

  assert.equal(notification.title, "GitHub issue_comment for patinaproject/codex-github-router");
  assert.match(notification.description, /using organization settings patinaproject/);
  assert.match(notification.description, /Sender: tlmader/);
  assert.match(notification.description, /leave a test comment on our PR/);
});

test("delivers to explicit router Codex thread ID when available", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-123", "turn-123");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-123",
    turnId: "turn-123",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "codex");
  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
  assert.match(child.stdinLines[0] ?? "", /"method":"initialize"/);
  assert.match(child.stdinLines[0] ?? "", /"version":"0\.1\.0"/);
  assert.match(child.stdinLines[1] ?? "", /"method":"initialized"/);
  assert.match(child.stdinLines[2] ?? "", new RegExp('"method":"thread/resume"'));
  assert.match(child.stdinLines[3] ?? "", new RegExp('"method":"turn/start"'));
  assert.match(child.stdinLines[3] ?? "", /Received issue_comment delivery/);
  assert.doesNotMatch(child.stdinLines[3] ?? "", /text_elements/);
});

test("live delivery proves the target thread is loaded before starting a turn", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-live",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello live" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_MODE: "proxy",
      CODEX_GITHUB_ROUTER_DELIVERY_MODE: "live",
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-live",
      HOME: "/home/test",
    }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeLiveAppServerResponses(child, "thread-live", "turn-live");
  const result = await delivery;

  assert.equal(result.delivered, true);
  assert.equal(result.threadId, "thread-live");
  assert.equal(result.turnId, "turn-live");
  assert.equal(result.deliveryMode, "live");
  assert.equal(result.transportMode, "live");
  assert.deepEqual(calls[0]?.args, ["app-server", "proxy"]);
  assert.match(child.stdinLines[2] ?? "", /"method":"thread\/loaded\/list"/);
  assert.match(child.stdinLines[3] ?? "", /"method":"thread\/resume"/);
  assert.match(child.stdinLines[4] ?? "", /"method":"turn\/start"/);
});

test("live delivery fails closed when the selected app-server has not loaded the target thread", async () => {
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-live-missing",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello live" },
    },
  }, {
    cwd: "/repo",
    env: {
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_MODE: "proxy",
      CODEX_GITHUB_ROUTER_DELIVERY_MODE: "live",
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-live",
      HOME: "/home/test",
    },
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => child,
  });
  await writeLiveThreadMissingResponses(child);

  await assert.rejects(delivery, /target thread thread-live is not loaded/u);
  assert.equal(child.stdinLines.some((line) => line.includes('"method":"turn/start"')), false);
});

test("auto delivery downgrades to background when live delivery cannot prove loaded-thread ownership", async () => {
  const liveChild = createAppServerProcess();
  const backgroundChild = createAppServerProcess();
  const children = [liveChild, backgroundChild];
  const spawnArgs: readonly string[][] = [];
  const logs: string[] = [];
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-auto",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello auto" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_MODE: "proxy",
      CODEX_GITHUB_ROUTER_DELIVERY_MODE: "auto",
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-auto",
      HOME: "/home/test",
    }),
    appServerLog: (message) => logs.push(message),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: (_file, args) => {
      spawnArgs.push([...args]);
      return children.shift() ?? createAppServerProcess();
    },
  });
  await writeLiveThreadMissingResponses(liveChild);
  await writeAppServerResponses(backgroundChild, "thread-auto", "turn-auto");
  const result = await delivery;

  assert.equal(result.delivered, true);
  assert.equal(result.deliveryMode, "auto");
  assert.equal(result.transportMode, "background");
  assert.equal(result.fallbackReason, "target thread thread-auto is not loaded in the live Codex app-server");
  assert.deepEqual(spawnArgs[0], ["app-server", "proxy"]);
  assert.deepEqual(spawnArgs[1], ["app-server", "--listen", "stdio://"]);
  assert.match(logs.join("\n"), /auto delivery falling back to background/);
});

test("auto delivery does not downgrade after live delivery proves thread ownership", async () => {
  const liveChild = createAppServerProcess();
  const spawned: string[] = [];
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-auto-live-failed",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello auto" },
    },
  }, {
    cwd: "/repo",
    env: {
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_MODE: "proxy",
      CODEX_GITHUB_ROUTER_DELIVERY_MODE: "auto",
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-auto",
      HOME: "/home/test",
    },
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: (_file, args) => {
      spawned.push(args.join(" "));
      return liveChild;
    },
  });
  await writeLiveTurnFailureAfterProof(liveChild, "thread-auto", "turn-live-failed");

  await assert.rejects(delivery, /turn-live-failed completed with status failed/u);
  assert.equal(spawned.length, 1);
});


test("logs app-server protocol interactions without message bodies", async () => {
  const child = createAppServerProcess();
  const logs: string[] = [];
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "sensitive PR comment body" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    appServerLog: (message) => logs.push(message),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => child,
  });
  await writeAppServerResponses(child, "thread-123", "turn-123");
  await delivery;

  assert.match(logs.join("\n"), /\[codex-app-server\] spawn codex app-server --listen stdio:\/\//);
  assert.match(logs.join("\n"), /\[codex-app-server\] opened app-server transport: stdio/);
  assert.match(logs.join("\n"), /-> request initialize id=1/);
  assert.match(logs.join("\n"), /-> request thread\/resume id=2 thread=thread-123/);
  assert.match(logs.join("\n"), /-> request turn\/start id=3 thread=thread-123 input=1 item/);
  assert.match(logs.join("\n"), /<- response id=3 for turn\/start turn=turn-123/);
  assert.match(logs.join("\n"), /<- notification turn\/completed thread=thread-123 turn=turn-123 status=completed/);
  assert.doesNotMatch(logs.join("\n"), /sensitive PR comment body/);
});

test("returns and logs the completed Codex agent response", async () => {
  const child = createAppServerProcess();
  const logs: string[] = [];
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "please acknowledge" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    appServerLog: (message) => logs.push(message),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => child,
  });
  await writeAppServerResponsesWithAgentMessage(child, "thread-123", "turn-123");
  const result = await delivery;

  assert.equal(result.agentMessage, "Acknowledged. No follow-up needed.");
  assert.match(logs.join("\n"), /<- notification item\/agentMessage\/delta thread=thread-123 turn=turn-123/);
  assert.match(logs.join("\n"), /agent response: Acknowledged\. No follow-up needed\./);
  assert.doesNotMatch(logs.join("\n"), /please acknowledge/);
});

test("prefers the Codex app-server binary when it exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const bundledAppServerBin = path.join(home, "Codex.app", "Contents", "Resources", "codex");
  await mkdir(path.dirname(bundledAppServerBin), { recursive: true });
  await writeFile(bundledAppServerBin, "");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({
      CODEX_APP_BUNDLED_APP_SERVER_BIN: bundledAppServerBin,
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123",
      HOME: "/home/test",
    }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-123", "turn-123");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-123",
    turnId: "turn-123",
    appServerBin: bundledAppServerBin,
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.equal(calls[0]?.file, bundledAppServerBin);
  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
});

test("defaults to stdio transport when the app-server control socket is available", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const controlSocket = path.join(home, "codex-ipc", "ipc-test.sock");
  await mkdir(path.dirname(controlSocket), { recursive: true });
  await writeFile(controlSocket, "");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const logs: string[] = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: {
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_CONTROL_SOCKET: controlSocket,
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123",
      HOME: "/home/test",
    },
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    appServerLog: (message) => logs.push(message),
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-123", "turn-123");
  await delivery;

  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
  assert.match(logs.join("\n"), /\[codex-app-server\] opened app-server transport: stdio/);
});

test("can explicitly request stdio transport mode", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_MODE: "listen",
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123",
      HOME: "/home/test",
    }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-123", "turn-123");
  await delivery;

  assert.equal(calls[0]?.file, "codex");
  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
});

test("passes a configured app-server control socket to proxy mode", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const controlSocket = path.join(home, "codex-ipc", "ipc-test.sock");
  await mkdir(path.dirname(controlSocket), { recursive: true });
  await writeFile(controlSocket, "");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: {
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_APP_SERVER_MODE: "proxy",
      CODEX_APP_SERVER_CONTROL_SOCKET: controlSocket,
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123",
      HOME: "/home/test",
    },
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-123", "turn-123");
  await delivery;

  assert.deepEqual(calls[0]?.args, ["app-server", "proxy", "--sock", controlSocket]);
});

test("ignores ambient Codex thread ID when launched from Codex", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_THREAD_ID: "thread-launcher" }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "git") {
        return { stdout: "feature-branch\n", stderr: "" };
      }
      if (file === "sqlite3") {
        return { stdout: "thread-matched\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args, options) => {
      calls.push({ file, args });
      spawnedEnv = options.env;
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-matched", "turn-matched");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-matched",
    turnId: "turn-matched",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.match(child.stdinLines[2] ?? "", /"threadId":"thread-matched"/);
  assert.doesNotMatch(child.stdinLines[2] ?? "", /thread-launcher/);
  assert.equal(spawnedEnv?.CODEX_THREAD_ID, undefined);
});

test("rejects a started Codex turn that later fails", async () => {
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => child,
  });
  await writeFailedAppServerTurn(child, "thread-123", "turn-123");

  await assert.rejects(delivery, /thread thread-123: Codex app-server codex app-server --listen stdio:\/\/ turn turn-123 completed with status failed/u);
});

test("queues delivery until an active Codex turn completes", async () => {
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-active",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "active turn comment" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => child,
  });
  await writeActiveTurnQueueResponses(child, "thread-123");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-123",
    turnId: "turn-queued",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.match(child.stdinLines[2] ?? "", /"method":"thread\/resume"/);
  assert.match(child.stdinLines[3] ?? "", /"method":"turn\/start"/);
  assert.match(child.stdinLines[3] ?? "", /Received issue_comment delivery delivery-active/);
  assert.equal(child.stdinLines.filter((line) => line.includes('"method":"turn/start"')).length, 1);
  assert.equal(child.stdinLines.some((line) => line.includes('"method":"turn/steer"')), false);
});

test("compacts and retries when a routed Codex turn exceeds the context window", async () => {
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "hello" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => child,
  });
  await writeCompactedRetryAppServerTurn(child, "thread-123");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-123",
    turnId: "turn-retry",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.match(child.stdinLines[4] ?? "", /"method":"thread\/compact\/start"/);
  assert.match(child.stdinLines[5] ?? "", /"method":"turn\/start"/);
  assert.match(child.stdinLines[5] ?? "", /Received issue_comment delivery/);
});

test("discovers the latest matching Codex thread from local state", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "pull_request_review_comment",
    route: { kind: "repository", name: "patinaproject/codex-github-router" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "please adjust this" },
    },
  }, {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test" }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "git") {
        return { stdout: "feature-branch\n", stderr: "" };
      }
      if (file === "sqlite3" && args[0] === "/home/test/.codex/state_5.sqlite") {
        return { stdout: "thread-456\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-456", "turn-456");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-456",
    turnId: "turn-456",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.equal(calls.filter((call) => call.file === "sqlite3").length, 1);
  assert.match(String(calls[1]?.args[1]), /git_branch = 'feature-branch'/);
  assert.equal(calls[2]?.file, "codex");
});

test("routes pull request comments to the Codex session for the PR head branch", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "21");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "rollout-main.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-main",
      cwd: "/repos/router-main",
    },
  })}\n`);
  await writeFile(path.join(sessionDir, "rollout-pr.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-pr",
      cwd: "/repos/router-pr",
    },
  })}\n`);

  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      issue: {
        number: 4,
        pull_request: { url: "https://api.github.com/repos/patinaproject/codex-github-router/pulls/4" },
      },
      comment: { body: "please look" },
    },
  }, {
    cwd: "/repos/router-main",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: home }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "gh") {
        return { stdout: "feature/pr-chat-routing\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router-main" && args[2] === "remote") {
        return { stdout: "git@github.com:patinaproject/codex-github-router.git\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router-main" && args[2] === "branch") {
        return { stdout: "main\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router-pr" && args[2] === "remote") {
        return { stdout: "git@github.com:patinaproject/codex-github-router.git\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router-pr" && args[2] === "branch") {
        return { stdout: "feature/pr-chat-routing\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-pr", "turn-pr");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-pr",
    turnId: "turn-pr",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.match(child.stdinLines[2] ?? "", /"threadId":"thread-pr"/);
});

test("ignores subagent sessions when routing pull request comments", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "21");
  await mkdir(sessionDir, { recursive: true });
  const humanSession = path.join(sessionDir, "rollout-human.jsonl");
  const subagentSession = path.join(sessionDir, "rollout-subagent.jsonl");
  await writeFile(humanSession, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-human",
      cwd: "/repos/router",
    },
  })}\n`);
  await writeFile(subagentSession, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-subagent",
      cwd: "/repos/router",
      thread_source: "subagent",
      source: { subagent: { thread_spawn: { parent_thread_id: "thread-human" } } },
    },
  })}\n`);
  const now = new Date();
  await utimes(humanSession, now, new Date(now.getTime() - 1000));
  await utimes(subagentSession, now, now);

  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      issue: {
        number: 4,
        pull_request: { url: "https://api.github.com/repos/patinaproject/codex-github-router/pulls/4" },
      },
      comment: { body: "please look" },
    },
  }, {
    cwd: "/repos/router",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: home }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "gh") {
        return { stdout: "feature/pr-chat-routing\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router" && args[2] === "remote") {
        return { stdout: "git@github.com:patinaproject/codex-github-router.git\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router" && args[2] === "branch") {
        return { stdout: "feature/pr-chat-routing\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-human", "turn-human");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-human",
    turnId: "turn-human",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.match(child.stdinLines[2] ?? "", /"threadId":"thread-human"/);
});

test("routes pull request reviews using the payload PR head branch", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "21");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "rollout-review.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-review",
      cwd: "/repos/router-review",
    },
  })}\n`);

  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const child = createAppServerProcess();
  const delivery = deliverToCodexInbox({
    event: "pull_request_review",
    deliveryId: "delivery-2",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      action: "submitted",
      repository: { full_name: "patinaproject/codex-github-router" },
      pull_request: {
        number: 4,
        head: { ref: "feature/review-routing" },
      },
      review: { html_url: "https://github.com/patinaproject/codex-github-router/pull/4#pullrequestreview-1" },
    },
  }, {
    cwd: "/repos/router-main",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: home }),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "git" && args[1] === "/repos/router-review" && args[2] === "remote") {
        return { stdout: "https://github.com/patinaproject/codex-github-router.git\n", stderr: "" };
      }
      if (file === "git" && args[1] === "/repos/router-review" && args[2] === "branch") {
        return { stdout: "feature/review-routing\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    spawnProcess: (file, args) => {
      calls.push({ file, args });
      return child;
    },
  });
  await writeAppServerResponses(child, "thread-review", "turn-review");
  const result = await delivery;

  assert.deepEqual(result, {
    delivered: true,
    threadId: "thread-review",
    turnId: "turn-review",
    appServerBin: "codex",
    deliveryMode: "background",
    transportMode: "background",
  });
  assert.equal(calls.some((call) => call.file === "gh"), false);
});

test("reports an undelivered event when no Codex thread matches", async () => {
  const result = await deliverToCodexInbox({
    event: "issue_comment",
    route: { kind: "organization", name: "patinaproject" },
    payload: { repository: { full_name: "patinaproject/codex-github-router" } },
  }, {
    cwd: "/repo",
    env: { HOME: "/home/test" },
    execFile: async (file) => {
      if (file === "git") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(result, {
    delivered: false,
    deliveryMode: "background",
    transportMode: "none",
    reason: "no matching Codex thread found",
  });
});
