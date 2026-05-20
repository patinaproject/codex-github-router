import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.js";

function createContext(env = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
  stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
  return {
    context: { cwd: process.cwd(), env, stdin: new PassThrough(), stdout, stderr },
    output: () => ({ stdout: out, stderr: err }),
  };
}

test("prints top-level help", async () => {
  const { context, output } = createContext();
  const code = await runCli(["--help"], context);

  assert.equal(code, 0);
  assert.match(output().stdout, /doctor/);
  assert.match(output().stdout, /request get/);
});

test("clears local state with JSON output", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const { context, output } = createContext({ HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache") });
  const code = await runCli(["--json", "--clear"], context);

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output().stdout), { ok: true, cleared: true });
});

test("returns machine-readable errors under --json", async () => {
  const { context, output } = createContext();
  const code = await runCli(["--json", "unknown"], context);

  assert.equal(code, 1);
  assert.equal(JSON.parse(output().stdout).ok, false);
});

test("returns from failed default tunnel startup instead of hanging", async () => {
  const { context, output } = createContext();
  const code = await runCli(["--json", "--port", "0"], {
    ...context,
    env: { ...context.env, PATH: "/path/without/ngrok" },
  });

  assert.equal(code, 1);
  assert.equal(JSON.parse(output().stdout).ok, false);
});
