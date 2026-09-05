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
      child.emit("exit", null, signal);
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

async function waitOneTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function timeoutDelivery(env: NodeJS.ProcessEnv = {}) {
  const children: ReturnType<typeof createAppServerProcess>[] = [];
  const logs: string[] = [];
  const delivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-timeout",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "sensitive retry comment body" },
    },
  }, {
    cwd: "/repo",
    env: {
      CODEX_APP_SERVER_BIN: "codex",
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-timeout",
      CODEX_APP_SERVER_TIMEOUT_MS: "100",
      CODEX_APP_SERVER_TIMEOUT_RETRY_DELAY_MS: "0",
      ...env,
    },
    appServerLog: (message) => logs.push(message),
    spawnProcess: () => {
      const child = createAppServerProcess();
      children.push(child);
      return child;
    },
  });
  return { delivery, children, logs };
}

async function resumeTimedOutThread(child: ReturnType<typeof createAppServerProcess>, active = false): Promise<void> {
  await waitOneTick();
  child.stdout.write(`${JSON.stringify({ id: "1", result: {} })}\n`);
  child.stdout.write(`${JSON.stringify({ id: "2", result: { thread: {
    id: "thread-timeout", status: { type: active ? "active" : "idle" },
  } } })}\n`);
  if (!active) {
    child.stdout.write(`${JSON.stringify({ id: "3", result: { turn: { id: "turn-stalled" } } })}\n`);
  }
}

test("retries a timed-out delivery with the same thread and input and body-safe logs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { delivery, children, logs } = timeoutDelivery();
  const outcome = delivery.then((result) => result, (error: unknown) => error);
  await waitOneTick();
  const first = children[0]!;
  await resumeTimedOutThread(first);
  t.mock.timers.tick(100);
  await waitOneTick();
  assert.equal(children.length, 2, "a timeout spawns one fresh app-server");
  assert.deepEqual(first.killedSignals, ["SIGTERM"]);
  const second = children[1]!;
  await writeAppServerResponsesWithAgentMessage(second, "thread-timeout", "turn-recovered");
  assert.deepEqual(await outcome, {
    delivered: true,
    threadId: "thread-timeout",
    turnId: "turn-recovered",
    agentMessage: "Acknowledged. No follow-up needed.",
    appServerBin: "codex",
  });
  assert.deepEqual(second.stdinLines, first.stdinLines, "each attempt repeats the same protocol and notification");
  assert.deepEqual(second.stdinLines.map((line) => JSON.parse(line).method), [
    "initialize", "initialized", "thread/resume", "turn/start",
  ]);
  assert.match(logs.join("\n"), /retry attempt 2\/2/);
  assert.match(logs.join("\n"), /attempt 2\/2 completed/);
  assert.doesNotMatch(logs.join("\n"), /sensitive retry comment body/);
});

for (const active of [false, true]) {
  test(`stops after the retry times out ${active ? "behind an active turn" : "waiting for completion"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { delivery, children, logs } = timeoutDelivery();
    const rejected = assert.rejects(delivery, (error: Error) => {
      assert.match(error.message, /thread thread-timeout: Timed out waiting for Codex app-server codex app-server --listen stdio:\/\/ turn completion after 100ms/);
      assert.match(error.message, /timeout attempts exhausted \(2\/2\)/);
      assert.match(error.message, active ? /thread remained active/ : /phase=waiting/);
      return true;
    });
    await waitOneTick();
    await resumeTimedOutThread(children[0]!, active);
    t.mock.timers.tick(100);
    await waitOneTick();
    await resumeTimedOutThread(children[1]!, active);
    t.mock.timers.tick(100);
    await rejected;
    assert.equal(children.length, 2, "exhausted retries cannot spawn another app-server");
    assert.ok(children.every((child) => child.killedSignals.join() === "SIGTERM"));
    assert.match(logs.join("\n"), /attempt 2\/2 timed out/);
    assert.doesNotMatch(logs.join("\n"), /sensitive retry comment body/);
    if (active) {
      assert.ok(children.every((child) => child.stdinLines.length === 3), "a stuck active thread never receives turn/start");
    }
  });
}

test("retries after timing out behind an active turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { delivery, children } = timeoutDelivery();
  await waitOneTick();
  await resumeTimedOutThread(children[0]!, true);
  assert.equal(children[0]!.stdinLines.length, 3);
  t.mock.timers.tick(100);
  await waitOneTick();
  await writeAppServerResponses(children[1]!, "thread-timeout", "turn-recovered");
  assert.equal((await delivery).turnId, "turn-recovered");
  assert.equal(children.length, 2);
});

test("waits for the timed-out child's exit and configured delay before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { delivery, children } = timeoutDelivery({ CODEX_APP_SERVER_TIMEOUT_RETRY_DELAY_MS: "25" });
  await waitOneTick();
  const first = children[0]!;
  first.kill = (signal) => {
    first.killedSignals.push(String(signal));
    return true;
  };
  await resumeTimedOutThread(first);
  t.mock.timers.tick(100);
  await waitOneTick();
  assert.deepEqual(first.killedSignals, ["SIGTERM"]);
  assert.equal(children.length, 1, "sending SIGTERM alone does not allow the next attempt");
  first.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thread-timeout", turn: { id: "turn-stalled", status: "completed" },
  } })}\n`);
  first.emit("exit", null, "SIGTERM");
  await waitOneTick();
  t.mock.timers.tick(24);
  await waitOneTick();
  assert.equal(children.length, 1, "the retry delay begins after process exit");
  t.mock.timers.tick(1);
  await waitOneTick();
  assert.equal(children.length, 2);
  await writeAppServerResponses(children[1]!, "thread-timeout", "turn-recovered");
  assert.equal((await delivery).turnId, "turn-recovered", "late completion from a timed-out child cannot settle delivery");
});

test("kills a timed-out child that ignores SIGTERM before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { delivery, children } = timeoutDelivery();
  await waitOneTick();
  const first = children[0]!;
  first.kill = (signal) => {
    first.killedSignals.push(String(signal));
    if (signal === "SIGKILL") first.emit("exit", null, signal);
    return true;
  };
  t.mock.timers.tick(100);
  await waitOneTick();
  assert.equal(children.length, 1);
  t.mock.timers.tick(1000);
  await waitOneTick();
  assert.deepEqual(first.killedSignals, ["SIGTERM", "SIGKILL"]);
  await writeAppServerResponses(children[1]!, "thread-timeout", "turn-recovered");
  assert.equal((await delivery).turnId, "turn-recovered");
});

test("zero timeout retries preserves single-attempt failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { delivery, children } = timeoutDelivery({ CODEX_APP_SERVER_TIMEOUT_RETRIES: "0" });
  const rejected = assert.rejects(delivery, /Timed out waiting for Codex app-server.*after 100ms; timeout attempts exhausted \(1\/1\)/);
  await waitOneTick();
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(children.length, 1);
  assert.deepEqual(children[0]!.killedSignals, ["SIGTERM"]);
});

for (const failure of ["authentication", "protocol", "exit", "failed turn"]) {
  test(`does not retry an app-server ${failure} failure`, async () => {
    const { delivery, children } = timeoutDelivery();
    const expected = {
      authentication: /authentication failed/,
      protocol: /protocol failed/,
      exit: /exited before starting a turn with code 1/,
      "failed turn": /completed with status failed/,
    }[failure]!;
    const rejected = assert.rejects(delivery, expected);
    await waitOneTick();
    const child = children[0]!;
    if (failure === "authentication") await writeAppServerAuthFailure(child);
    if (failure === "protocol") child.stdout.write(`${JSON.stringify({ id: "1", error: { message: "protocol failed" } })}\n`);
    if (failure === "exit") child.emit("exit", 1);
    if (failure === "failed turn") await writeFailedAppServerTurn(child, "thread-timeout", "turn-failed");
    await rejected;
    assert.equal(children.length, 1);
  });
}

test("honors a configured retry count", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { delivery, children } = timeoutDelivery({ CODEX_APP_SERVER_TIMEOUT_RETRIES: "2" });
  await waitOneTick();
  t.mock.timers.tick(100);
  await waitOneTick();
  t.mock.timers.tick(100);
  await waitOneTick();
  assert.equal(children.length, 3);
  await writeAppServerResponses(children[2]!, "thread-timeout", "turn-recovered");
  assert.equal((await delivery).turnId, "turn-recovered");
});

test("holds the thread lock through the default retry delay and recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = timeoutDelivery({ CODEX_APP_SERVER_TIMEOUT_RETRY_DELAY_MS: undefined });
  await waitOneTick();
  const queued = timeoutDelivery();
  t.mock.timers.tick(100);
  await waitOneTick();
  t.mock.timers.tick(999);
  await waitOneTick();
  assert.equal(first.children.length, 1, "the default delay is one second after exit");
  assert.equal(queued.children.length, 0, "a later delivery cannot overtake the retry");
  t.mock.timers.tick(1);
  await waitOneTick();
  assert.equal(first.children.length, 2);
  assert.equal(queued.children.length, 0);
  await writeAppServerResponses(first.children[1]!, "thread-timeout", "turn-recovered");
  assert.equal((await first.delivery).turnId, "turn-recovered");
  await waitOneTick();
  await writeAppServerResponses(queued.children[0]!, "thread-timeout", "turn-next");
  assert.equal((await queued.delivery).turnId, "turn-next");
});

for (const name of ["CODEX_APP_SERVER_TIMEOUT_RETRIES", "CODEX_APP_SERVER_TIMEOUT_RETRY_DELAY_MS"]) {
  for (const value of ["", "-1", "0.5", "NaN", "Infinity", "9007199254740991"]) {
    test(`rejects invalid ${name}=${JSON.stringify(value)} before spawning`, async () => {
      const { delivery, children } = timeoutDelivery({ [name]: value });
      await assert.rejects(delivery, new RegExp(`${name} must be an integer`));
      assert.equal(children.length, 0);
    });
  }
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

async function writeAppServerAuthFailure(child: ReturnType<typeof createAppServerProcess>): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  child.stderr.write("2026-05-26T05:15:59.076122Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed(\"Server returned error response: invalid_grant: Invalid refresh token\"))\n");
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

test("serializes concurrent deliveries to the same Codex thread", async () => {
  const children: Array<ReturnType<typeof createAppServerProcess>> = [];
  const deliveryOptions = {
    cwd: "/repo",
    env: envWithoutAppServerControlSocket({ CODEX_APP_SERVER_BIN: "codex", HOME: "/home/test", CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123" }),
    execFile: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: () => {
      const child = createAppServerProcess();
      children.push(child);
      return child;
    },
  };
  const firstDelivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-1",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "first" },
    },
  }, deliveryOptions);
  const secondDelivery = deliverToCodexInbox({
    event: "issue_comment",
    deliveryId: "delivery-2",
    route: { kind: "organization", name: "patinaproject" },
    payload: {
      repository: { full_name: "patinaproject/codex-github-router" },
      comment: { body: "second" },
    },
  }, deliveryOptions);

  await waitOneTick();
  const spawnedBeforeFirstCompletion = children.length;
  if (spawnedBeforeFirstCompletion !== 1) {
    await Promise.all(children.map((child, index) => writeAppServerResponses(child, "thread-123", `turn-${index + 1}`)));
    await Promise.allSettled([firstDelivery, secondDelivery]);
  }
  assert.equal(spawnedBeforeFirstCompletion, 1);

  await writeAppServerResponses(children[0]!, "thread-123", "turn-1");
  assert.equal((await firstDelivery).turnId, "turn-1");

  await waitOneTick();
  assert.equal(children.length, 2);

  await writeAppServerResponses(children[1]!, "thread-123", "turn-2");
  assert.equal((await secondDelivery).turnId, "turn-2");
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
  });
  assert.equal(calls[0]?.file, bundledAppServerBin);
  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
});

test("always uses stdio transport when the app-server control socket is available", async () => {
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

test("ignores proxy mode configuration and still uses stdio", async () => {
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

  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
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

test("reports stale Codex app-server refresh tokens as an auth failure", async () => {
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
  await writeAppServerAuthFailure(child);

  await assert.rejects(delivery, /thread thread-123: Codex app-server authentication failed: refresh token is invalid or expired. Sign in to Codex again, then retry./u);
  assert.deepEqual(child.killedSignals, ["SIGTERM"]);
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
    reason: "no matching Codex thread found",
  });
});
