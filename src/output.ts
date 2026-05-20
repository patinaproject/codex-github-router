import type { Writable } from "node:stream";

export type CliResult = { ok: true; [key: string]: unknown } | { ok: false; error: { code: string; message: string; [key: string]: unknown } };

export function writeJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function ok(data: Record<string, unknown> = {}): CliResult {
  return { ok: true, ...data };
}

export function fail(code: string, message: string, details: Record<string, unknown> = {}): CliResult {
  return { ok: false, error: { code, message, ...details } };
}

export function redact<T>(value: T): T | "[redacted]" {
  if (!value) {
    return value;
  }
  return "[redacted]";
}

export function colorize(
  text: string,
  color: "green" | "yellow" | "cyan" | "red" | "bold" | "dim",
  { env = process.env, stream = process.stdout }: { env?: NodeJS.ProcessEnv; stream?: Writable & { isTTY?: boolean } } = {},
): string {
  if (env.NO_COLOR || (!env.FORCE_COLOR && !stream.isTTY)) {
    return text;
  }
  const colors = {
    green: 32,
    yellow: 33,
    cyan: 36,
    red: 31,
    bold: 1,
    dim: 2,
  };
  return `\u001b[${colors[color] ?? 0}m${text}\u001b[0m`;
}
