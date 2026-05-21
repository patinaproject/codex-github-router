const DEFAULT_WEBHOOK_PATH = "/webhooks/github";

export function normalizeWebhookUrl(input: string): string {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("URL must be an absolute HTTPS URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("URL must use HTTPS");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("URL must not include a query string or fragment");
  }

  const hasPath = parsed.pathname !== "/";
  if (!hasPath) {
    parsed.pathname = DEFAULT_WEBHOOK_PATH;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function localWebhookUrl(port: number): string {
  return `http://127.0.0.1:${port}${DEFAULT_WEBHOOK_PATH}`;
}

export { DEFAULT_WEBHOOK_PATH };
