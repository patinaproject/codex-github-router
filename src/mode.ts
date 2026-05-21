import { normalizeWebhookUrl } from "./url.js";

export interface RouterOptions {
  json: boolean;
  clear: boolean;
  localhost: boolean;
  port: number;
  url?: string | undefined;
  help?: boolean;
}

export type RouterMode =
  | { kind: "clear" }
  | { kind: "localhost" }
  | { kind: "url"; publicWebhookUrl: string }
  | { kind: "tunnel" };

export function parseRouterMode(options: Partial<RouterOptions>): RouterMode {
  const enabled = [options.url ? "--url" : null, options.localhost ? "--localhost" : null]
    .filter(Boolean);

  if (enabled.length > 1) {
    throw new Error(`${enabled.join(" and ")} cannot be used together`);
  }
  if (options.clear && enabled.length > 0) {
    throw new Error("--clear cannot be combined with router startup options");
  }

  if (options.clear) {
    return { kind: "clear" };
  }
  if (options.localhost) {
    return { kind: "localhost" };
  }
  if (options.url) {
    return { kind: "url", publicWebhookUrl: normalizeWebhookUrl(options.url) };
  }
  return { kind: "tunnel" };
}
