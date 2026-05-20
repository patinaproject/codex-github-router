import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { discoverNgrokUrl, startNgrokTunnel } from "../src/tunnel.js";

test("discovers the HTTPS public URL from ngrok tunnel metadata", async () => {
  const publicUrl = await discoverNgrokUrl({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tunnels: [
          { public_url: "http://example.ngrok-free.app", config: { addr: "http://localhost:3000" } },
          { public_url: "https://example.ngrok-free.app", config: { addr: "http://localhost:3000" } },
        ],
      }),
    }),
  });

  assert.equal(publicUrl, "https://example.ngrok-free.app");
});

test("discovers the HTTPS tunnel for the requested local port", async () => {
  const publicUrl = await discoverNgrokUrl({
    expectedPort: 4242,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tunnels: [
          { public_url: "https://wrong.ngrok-free.app", config: { addr: "http://localhost:3000" } },
          { public_url: "https://right.ngrok-free.app", config: { addr: "http://127.0.0.1:4242" } },
        ],
      }),
    }),
  });

  assert.equal(publicUrl, "https://right.ngrok-free.app");
});

test("rejects ngrok metadata without an HTTPS public URL", async () => {
  await assert.rejects(
    discoverNgrokUrl({
      fetchImpl: async () => ({ ok: true, json: async () => ({ tunnels: [] }) }),
    }),
    /HTTPS tunnel/,
  );
});

test("reports ngrok spawn errors instead of leaving them unhandled", async () => {
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new PassThrough();
  fakeProcess.exitCode = null;
  fakeProcess.kill = () => true;

  await assert.rejects(
    startNgrokTunnel({
      port: 3000,
      timeoutMs: 1000,
      spawnImpl: () => {
        queueMicrotask(() => fakeProcess.emit("error", new Error("spawn ngrok ENOENT")));
        return fakeProcess;
      },
    }),
    /Failed to start ngrok/,
  );
});
