import http from "node:http";
import { isAllowedGitHubEvent } from "./github-events.js";
import { DEFAULT_WEBHOOK_PATH } from "./url.js";
import { verifyGitHubSignature } from "./security.js";
import type { DeliveryCache } from "./dedupe-cache.js";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export interface WebhookEvent {
  event: string;
  deliveryId?: string | undefined;
  payload: Record<string, unknown>;
}

async function readBody(request: http.IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePayload(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function eventAction(payload: Record<string, unknown>): string | undefined {
  return typeof payload.action === "string" ? payload.action : undefined;
}

function shouldIgnoreEvent(event: string, payload: Record<string, unknown>): boolean {
  return event === "pull_request";
}

export function createWebhookServer({
  mode,
  secret,
  deliveryCache,
  bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
  onEvent,
}: {
  mode: string;
  secret?: string | undefined;
  deliveryCache?: DeliveryCache;
  bodyLimitBytes?: number;
  onEvent?: (event: WebhookEvent) => void | Promise<void>;
}): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method !== "POST" || request.url !== DEFAULT_WEBHOOK_PATH) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: { code: "not_found" } }));
        return;
      }

      const body = await readBody(request, bodyLimitBytes);
      if (mode !== "localhost") {
        const signature = request.headers["x-hub-signature-256"];
        if (!verifyGitHubSignature({ secret, body, signature })) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: { code: "bad_signature" } }));
          return;
        }
      }

      const deliveryId = headerValue(request.headers["x-github-delivery"]);
      if (deliveryId && deliveryCache?.has(deliveryId)) {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, duplicate: true }));
        return;
      }

      const event = headerValue(request.headers["x-github-event"]) ?? "unknown";
      if (!isAllowedGitHubEvent(event)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: { code: "unsupported_event" } }));
        return;
      }
      const payload = parsePayload(body);
      if (shouldIgnoreEvent(event, payload)) {
        await rememberDelivery(deliveryCache, deliveryId);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, ignored: true, event, action: eventAction(payload), deliveryId }));
        return;
      }
      await rememberDelivery(deliveryCache, deliveryId);
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, event, deliveryId }));
      Promise.resolve(onEvent?.({ event, deliveryId, payload })).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad request";
      const status = message === "request body is too large" ? 413 : 400;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "bad_request", message } }));
    }
  });
}

async function rememberDelivery(deliveryCache: DeliveryCache | undefined, deliveryId: string | undefined): Promise<void> {
  if (!deliveryCache || !deliveryId) {
    return;
  }
  deliveryCache.add(deliveryId);
  try {
    await deliveryCache.save();
  } catch {
    return;
  }
}

export function listen(server: http.Server, { port = 0, host = "127.0.0.1" }: { port?: number; host?: string } = {}): Promise<import("node:net").AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("listener did not return a TCP address"));
        return;
      }
      resolve(address);
    });
  });
}
