import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor, preflightStartup } from "../src/doctor.js";
import { writeConfig } from "../src/config.js";

async function writeStubCommand(dir: string, name: string): Promise<void> {
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}

test("startup preflight requires ngrok only for managed tunnel mode", async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "router-bin-"));
  await Promise.all([
    writeStubCommand(binDir, "gh"),
    writeStubCommand(binDir, "git"),
    writeStubCommand(binDir, "codex"),
  ]);

  await preflightStartup({ env: { PATH: binDir }, requireTunnel: false });

  await assert.rejects(
    preflightStartup({ env: { PATH: binDir }, requireTunnel: true }),
    /ngrok/,
  );
});

test("startup preflight fails before GitHub mutation when gh auth is unavailable", async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "router-bin-"));
  await Promise.all([
    writeStubCommand(binDir, "git"),
    writeStubCommand(binDir, "codex"),
    writeStubCommand(binDir, "ngrok"),
    (async () => {
      const file = path.join(binDir, "gh");
      await writeFile(file, "#!/bin/sh\nif [ \"$1\" = auth ]; then exit 1; fi\nexit 0\n");
      await chmod(file, 0o755);
    })(),
  ]);

  await assert.rejects(
    preflightStartup({ env: { PATH: binDir }, requireTunnel: true }),
    /gh auth/,
  );
});

test("doctor reports setup still required for incomplete config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const binDir = await mkdtemp(path.join(os.tmpdir(), "router-bin-"));
  await Promise.all([
    writeStubCommand(binDir, "gh"),
    writeStubCommand(binDir, "git"),
    writeStubCommand(binDir, "codex"),
    writeStubCommand(binDir, "ngrok"),
  ]);
  const env = { HOME: home, PATH: binDir };
  await writeConfig({ version: 1, setupRequired: true }, { env });

  const result = await doctor({ env });

  assert.deepEqual(result.config, {
    present: true,
    setupRequired: true,
  });
});

test("doctor reports app-server readiness hints without probing comment content", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-home-"));
  const binDir = await mkdtemp(path.join(os.tmpdir(), "router-bin-"));
  const controlSocket = path.join(home, "codex-app-server.sock");
  await Promise.all([
    writeStubCommand(binDir, "gh"),
    writeStubCommand(binDir, "git"),
    writeStubCommand(binDir, "ngrok"),
    (async () => {
      const file = path.join(binDir, "codex");
      await writeFile(file, [
        `#!${process.execPath}`,
        "if (process.argv[2] === 'app-server' && process.argv[3] === 'daemon') { console.log('Manage the local app-server daemon'); process.exit(0); }",
        "if (process.argv[2] === 'app-server' && process.argv[3] === 'proxy') {",
        "  process.stdin.setEncoding('utf8');",
        "  let buffer = '';",
        "  process.stdin.on('data', (chunk) => {",
        "    buffer += chunk;",
        "    for (;;) {",
        "      const index = buffer.indexOf('\\n');",
        "      if (index < 0) break;",
        "      const line = buffer.slice(0, index).trim();",
        "      buffer = buffer.slice(index + 1);",
        "      if (!line) continue;",
        "      const message = JSON.parse(line);",
        "      if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));",
        "      if (message.method === 'thread/loaded/list') console.log(JSON.stringify({ id: message.id, result: { data: ['thread-123'] } }));",
        "    }",
        "  });",
        "} else {",
        "  console.log('codex-cli test');",
        "}",
      ].join("\n"));
      await chmod(file, 0o755);
    })(),
    writeFile(controlSocket, ""),
  ]);

  const result = await doctor({
    env: {
      CODEX_APP_SERVER_BIN: path.join(binDir, "codex"),
      CODEX_APP_SERVER_CONTROL_SOCKET: controlSocket,
      CODEX_GITHUB_ROUTER_THREAD_ID: "thread-123",
      HOME: home,
      PATH: binDir,
    },
  });

  assert.equal(result.appServer.binary, path.join(binDir, "codex"));
  assert.equal(result.appServer.managedDaemon.available, true);
  assert.deepEqual(result.appServer.controlSockets[0], {
    source: "CODEX_APP_SERVER_CONTROL_SOCKET",
    path: controlSocket,
    exists: true,
    protocol: "ok",
    detail: "initialize and thread/loaded/list responses received",
    targetThreadLoaded: true,
  });
  assert.deepEqual(result.appServer.targetThread, {
    id: "thread-123",
    loaded: true,
    detail: "loaded status proved through app-server thread/loaded/list",
  });
});
