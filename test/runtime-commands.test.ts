import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { attachRuntimeCommands } from "../src/runtime-commands.js";

test("does not attach runtime commands when stdin is not a TTY", () => {
  const result = attachRuntimeCommands({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    onReload() {},
    onSettings() {},
    onQuit() {},
  });

  assert.equal(result.enabled, false);
});

test("handles reload, settings, and quit commands case-insensitively", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  let reloads = 0;
  let settings = 0;
  let quits = 0;

  const runtime = attachRuntimeCommands({
    stdin,
    stdout,
    onReload: async () => { reloads += 1; },
    onSettings: async () => { settings += 1; },
    onQuit: async () => { quits += 1; },
  });

  stdin.write("R\n");
  stdin.write("s\n");
  stdin.write("Q\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.enabled, true);
  assert.equal(reloads, 1);
  assert.equal(settings, 1);
  assert.equal(quits, 1);
});
