import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryCache } from "../src/dedupe-cache.js";
import { createWebhookServer, listen } from "../src/listener.js";
import { signPayload } from "../src/security.js";

async function postJson(address, body, headers = {}) {
  return fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

test("accepts signed webhook payloads in URL mode", async () => {
  const body = JSON.stringify({ repository: { full_name: "owner/repo" } });
  const secret = "test-secret";
  const server = createWebhookServer({
    mode: "url",
    secret,
    deliveryCache: new DeliveryCache(),
  });
  const address = await listen(server);
  try {
    const response = await postJson(address, body, {
      "x-hub-signature-256": signPayload(secret, Buffer.from(body)),
      "x-github-delivery": "delivery-1",
      "x-github-event": "issues",
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, event: "issues", deliveryId: "delivery-1" });
  } finally {
    server.close();
  }
});

test("rejects unsigned webhook payloads outside localhost mode", async () => {
  const server = createWebhookServer({
    mode: "url",
    secret: "test-secret",
    deliveryCache: new DeliveryCache(),
  });
  const address = await listen(server);
  try {
    const response = await postJson(address, "{}");
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("rejects unsupported GitHub event types", async () => {
  const body = "{}";
  const server = createWebhookServer({
    mode: "localhost",
    deliveryCache: new DeliveryCache(),
  });
  const address = await listen(server);
  try {
    const response = await postJson(address, body, {
      "x-github-event": "ping",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: { code: "unsupported_event" } });
  } finally {
    server.close();
  }
});

test("deduplicates repeated delivery IDs", async () => {
  const body = "{}";
  const cache = new DeliveryCache();
  const server = createWebhookServer({
    mode: "localhost",
    deliveryCache: cache,
  });
  const address = await listen(server);
  try {
    const headers = { "x-github-delivery": "delivery-1", "x-github-event": "issues" };
    assert.equal((await postJson(address, body, headers)).status, 202);
    const second = await postJson(address, body, headers);
    assert.equal(second.status, 202);
    assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  } finally {
    server.close();
  }
});

test("does not cache delivery IDs when event routing fails", async () => {
  const body = "{}";
  const cache = new DeliveryCache();
  let attempts = 0;
  const server = createWebhookServer({
    mode: "localhost",
    deliveryCache: cache,
    onEvent: async () => {
      attempts += 1;
      throw new Error("routing failed");
    },
  });
  const address = await listen(server);
  try {
    const headers = { "x-github-delivery": "delivery-1", "x-github-event": "issues" };
    assert.equal((await postJson(address, body, headers)).status, 400);
    assert.equal((await postJson(address, body, headers)).status, 400);
    assert.equal(attempts, 2);
  } finally {
    server.close();
  }
});

test("rejects request bodies above the configured limit", async () => {
  const server = createWebhookServer({
    mode: "localhost",
    bodyLimitBytes: 2,
    deliveryCache: new DeliveryCache(),
  });
  const address = await listen(server);
  try {
    const response = await postJson(address, "{}{}");
    assert.equal(response.status, 413);
  } finally {
    server.close();
  }
});
