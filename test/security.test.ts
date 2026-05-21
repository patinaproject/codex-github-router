import assert from "node:assert/strict";
import test from "node:test";
import { generateWebhookSecret, signPayload, verifyGitHubSignature } from "../src/security.js";

test("verifies a valid GitHub SHA-256 webhook signature", () => {
  const body = Buffer.from(JSON.stringify({ action: "opened" }));
  const secret = "test-secret";
  const signature = signPayload(secret, body);

  assert.equal(verifyGitHubSignature({ secret, body, signature }), true);
});

test("rejects missing, malformed, mismatched, and wrong-length signatures", () => {
  const body = Buffer.from("{}");
  const secret = "test-secret";

  assert.equal(verifyGitHubSignature({ secret, body, signature: undefined }), false);
  assert.equal(verifyGitHubSignature({ secret, body, signature: "sha1=abc" }), false);
  assert.equal(verifyGitHubSignature({ secret, body, signature: signPayload("other", body) }), false);
  assert.equal(verifyGitHubSignature({ secret, body, signature: "sha256=abc" }), false);
});

test("generates a cryptographically random hex secret", () => {
  const first = generateWebhookSecret();
  const second = generateWebhookSecret();

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});
