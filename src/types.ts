import type { Readable, Writable } from "node:stream";

export interface RuntimeContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
}

export interface PathContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

export interface RouterConfig {
  version?: number | undefined;
  publicWebhookUrl?: string | undefined;
  localWebhookUrl?: string | undefined;
  setupRequired?: boolean | undefined;
  mode?: string | undefined;
  attachedToExistingTunnel?: boolean | undefined;
  repositories?: unknown[];
  organizations?: unknown[];
  hasStoredSecrets?: boolean;
}

export interface JsonObject {
  [key: string]: unknown;
}
