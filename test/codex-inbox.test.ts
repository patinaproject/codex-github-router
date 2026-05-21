import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildCodexInboxNotification, deliverToCodexInbox } from "../src/codex-inbox.js";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

test("delivers to explicit Codex thread ID when available", async () => {
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
    env: { HOME: "/home/test", CODEX_THREAD_ID: "thread-123" },
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

  assert.deepEqual(result, { delivered: true, threadId: "thread-123", turnId: "turn-123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "codex");
  assert.deepEqual(calls[0]?.args, ["app-server", "--listen", "stdio://"]);
  assert.match(child.stdinLines[0] ?? "", /"method":"initialize"/);
  assert.match(child.stdinLines[1] ?? "", /"method":"initialized"/);
  assert.match(child.stdinLines[2] ?? "", new RegExp('"method":"thread/resume"'));
  assert.match(child.stdinLines[3] ?? "", new RegExp('"method":"turn/start"'));
  assert.match(child.stdinLines[3] ?? "", /Received issue_comment delivery/);
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
    env: { HOME: "/home/test" },
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

  assert.deepEqual(result, { delivered: true, threadId: "thread-456", turnId: "turn-456" });
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
    env: { HOME: home },
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

  assert.deepEqual(result, { delivered: true, threadId: "thread-pr", turnId: "turn-pr" });
  assert.match(child.stdinLines[2] ?? "", /"threadId":"thread-pr"/);
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
    env: { HOME: home },
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

  assert.deepEqual(result, { delivered: true, threadId: "thread-review", turnId: "turn-review" });
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

  assert.deepEqual(result, { delivered: false, reason: "no matching Codex thread found" });
});
