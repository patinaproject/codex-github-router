import assert from "node:assert/strict";
import test from "node:test";
import { parseRouterMode } from "../src/mode.js";

test("defaults to managed tunnel mode", () => {
  assert.deepEqual(parseRouterMode({}), { kind: "tunnel" });
});

test("parses localhost mode", () => {
  assert.deepEqual(parseRouterMode({ localhost: true }), { kind: "localhost" });
});

test("normalizes explicit URL mode", () => {
  assert.deepEqual(parseRouterMode({ url: "https://router.example.com" }), {
    kind: "url",
    publicWebhookUrl: "https://router.example.com/webhooks/github",
  });
});

test("rejects mutually exclusive startup modes", () => {
  assert.throws(() => parseRouterMode({ url: "https://router.example.com", localhost: true }), /cannot be used together/);
});

test("rejects clear combined with startup options", () => {
  assert.throws(() => parseRouterMode({ clear: true, localhost: true }), /--clear/);
});
