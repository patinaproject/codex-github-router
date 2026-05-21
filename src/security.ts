import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export function generateWebhookSecret() {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, body: Buffer | string): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyGitHubSignature({
  secret,
  body,
  signature,
}: {
  secret?: string | undefined;
  body: Buffer | string;
  signature?: string | string[] | undefined;
}): boolean {
  if (Array.isArray(signature)) {
    return false;
  }
  if (!secret || !signature || !signature.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const expected = Buffer.from(signPayload(secret, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
