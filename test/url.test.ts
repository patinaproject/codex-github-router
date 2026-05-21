import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebhookUrl } from "../src/url.js";

test("normalizes a base HTTPS URL to the default webhook endpoint", () => {
  assert.equal(
    normalizeWebhookUrl("https://example.ngrok-free.app"),
    "https://example.ngrok-free.app/webhooks/github",
  );
});

test("preserves a full HTTPS endpoint path", () => {
  assert.equal(
    normalizeWebhookUrl("https://router.example.com/custom/github"),
    "https://router.example.com/custom/github",
  );
});

test("rejects non-HTTPS public URLs", () => {
  assert.throws(() => normalizeWebhookUrl("http://example.com"), /HTTPS/);
});

test("rejects query strings and fragments", () => {
  assert.throws(() => normalizeWebhookUrl("https://example.com?token=secret"), /query/);
  assert.throws(() => normalizeWebhookUrl("https://example.com#secret"), /query/);
});
