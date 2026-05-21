import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { discoverNgrokUrl, findExistingNgrokTunnel, parseNgrokApiPort, startNgrokTunnel } from "../src/tunnel.js";

test("discovers the HTTPS public URL from ngrok tunnel metadata", async () => {
  const publicUrl = await discoverNgrokUrl({
    apiPort: 4545,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tunnels: [
          { public_url: "http://example.ngrok-free.app", config: { addr: "http://localhost:3000" } },
          { public_url: "https://example.ngrok-free.app", config: { addr: "http://localhost:3000" } },
        ],
      }),
    } satisfies Response),
  });

  assert.equal(publicUrl, "https://example.ngrok-free.app");
});

test("queries the configured ngrok API port", async () => {
  const requestedUrls: string[] = [];
  await discoverNgrokUrl({
    apiPort: 4545,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          tunnels: [
            { public_url: "https://example.ngrok-free.app", config: { addr: "http://localhost:3000" } },
          ],
        }),
      } satisfies Response;
    },
  });

  assert.equal(requestedUrls[0], "http://127.0.0.1:4545/api/tunnels");
});

test("finds an existing ngrok tunnel and local upstream port", async () => {
  const requestedUrls: string[] = [];
  const tunnel = await findExistingNgrokTunnel({
    apiPorts: [4040, 4545],
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes(":4040")) {
        throw new Error("not running");
      }
      return {
        ok: true,
        json: async () => ({
          tunnels: [
            { public_url: "https://existing.ngrok-free.app", config: { addr: "http://127.0.0.1:8787" } },
          ],
        }),
      } satisfies Response;
    },
  });

  assert.deepEqual(tunnel, { publicUrl: "https://existing.ngrok-free.app", localPort: 8787, apiPort: 4545 });
  assert.deepEqual(requestedUrls, ["http://127.0.0.1:4040/api/tunnels", "http://127.0.0.1:4545/api/tunnels"]);
});

test("finds an existing ngrok tunnel only when it matches the expected port", async () => {
  const tunnel = await findExistingNgrokTunnel({
    expectedPort: 3000,
    apiPorts: [4545],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tunnels: [
          { public_url: "https://wrong.ngrok-free.app", config: { addr: "http://127.0.0.1:8787" } },
          { public_url: "https://right.ngrok-free.app", config: { addr: "http://127.0.0.1:3000" } },
        ],
      }),
    } satisfies Response),
  });

  assert.deepEqual(tunnel, { publicUrl: "https://right.ngrok-free.app", localPort: 3000, apiPort: 4545 });
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
      apiPort: 4545,
      timeoutMs: 1000,
      spawnImpl: () => {
        queueMicrotask(() => fakeProcess.emit("error", new Error("spawn ngrok ENOENT")));
        return fakeProcess;
      },
    }),
    /Failed to start ngrok/,
  );
});

test("parses the ngrok web API port from stderr", () => {
  assert.equal(parseNgrokApiPort('lvl=info msg="starting web service" obj=web addr=127.0.0.1:4041 allow_hosts=[]'), 4041);
});

test("starts ngrok with a local listener URL", async () => {
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new PassThrough();
  fakeProcess.exitCode = null;
  fakeProcess.kill = () => true;
  let spawnArgs: string[] = [];

  const result = await startNgrokTunnel({
    port: 3000,
    apiPort: 4545,
    timeoutMs: 1000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tunnels: [{ public_url: "https://example.ngrok-free.app", config: { addr: "http://127.0.0.1:3000" } }],
      }),
    } satisfies Response),
    spawnImpl: (_command, args) => {
      spawnArgs = args ?? [];
      return fakeProcess;
    },
  });

  assert.equal(result.publicUrl, "https://example.ngrok-free.app");
  assert.deepEqual(spawnArgs, ["http", "http://127.0.0.1:3000", "--log=stderr"]);
});

test("summarizes existing endpoint conflicts from ngrok", async () => {
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new PassThrough();
  fakeProcess.exitCode = null;
  fakeProcess.kill = () => true;

  await assert.rejects(
    startNgrokTunnel({
      port: 3000,
      apiPort: 4545,
      timeoutMs: 1000,
      fetchImpl: async () => {
        fakeProcess.exitCode = 1;
        fakeProcess.stderr.emit("data", "ERROR: ERR_NGROK_334\n");
        return { ok: false, json: async () => ({}) } satisfies Response;
      },
      spawnImpl: () => fakeProcess,
    }),
    /ngrok endpoint is already online/,
  );
});
