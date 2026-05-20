import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexInboxNotification, deliverToCodexInbox } from "../src/codex-inbox.js";

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
  const result = await deliverToCodexInbox({
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
  });

  assert.deepEqual(result, { delivered: true, threadId: "thread-123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "sqlite3");
  assert.equal(calls[0]?.args[0], "/home/test/.codex/sqlite/codex-dev.db");
  assert.match(String(calls[0]?.args[1]), /thread-123/);
  assert.match(String(calls[0]?.args[1]), /GitHub issue_comment/);
});

test("discovers the latest matching Codex thread from local state", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const result = await deliverToCodexInbox({
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
  });

  assert.deepEqual(result, { delivered: true, threadId: "thread-456" });
  assert.equal(calls.filter((call) => call.file === "sqlite3").length, 2);
  assert.match(String(calls[1]?.args[1]), /git_branch = 'feature-branch'/);
  assert.match(String(calls[2]?.args[1]), /thread-456/);
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
