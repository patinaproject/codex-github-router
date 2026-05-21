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
