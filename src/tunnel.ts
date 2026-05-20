import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

const DEFAULT_NGROK_API_PORT = 4040;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NgrokTunnel {
  public_url?: string;
  config?: {
    addr?: string;
  };
}

interface NgrokTunnelsResponse {
  tunnels?: NgrokTunnel[];
}

function tunnelTargetsPort(tunnel: NgrokTunnel, expectedPort: number | undefined): boolean {
  if (expectedPort === undefined) {
    return true;
  }
  const addr = tunnel.config?.addr;
  if (!addr) {
    return false;
  }
  try {
    return new URL(addr).port === String(expectedPort);
  } catch {
    return addr.endsWith(`:${expectedPort}`);
  }
}

export async function discoverNgrokUrl({
  fetchImpl = fetch,
  expectedPort,
  apiPort = DEFAULT_NGROK_API_PORT,
}: {
  fetchImpl?: typeof fetch;
  expectedPort?: number;
  apiPort?: number;
} = {}): Promise<string> {
  const response = await fetchImpl(`http://127.0.0.1:${apiPort}/api/tunnels`);
  if (!response.ok) {
    throw new Error(`ngrok tunnel API returned ${response.status}`);
  }
  const data = (await response.json()) as NgrokTunnelsResponse;
  const tunnel = data.tunnels?.find((item) => item.public_url?.startsWith("https://") && tunnelTargetsPort(item, expectedPort));
  if (!tunnel) {
    throw new Error("ngrok did not report an HTTPS tunnel");
  }
  if (!tunnel.public_url) {
    throw new Error("ngrok did not report an HTTPS tunnel");
  }
  return tunnel.public_url;
}

function parseNgrokApiPort(output: string): number | undefined {
  const match = output.match(/addr=127\.0\.0\.1:(\d+)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

export async function startNgrokTunnel({
  port,
  stderr,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  apiPort = DEFAULT_NGROK_API_PORT,
  timeoutMs = 10000,
}: {
  port: number;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  apiPort?: number;
  timeoutMs?: number;
}): Promise<{ publicUrl: string; process: ChildProcess }> {
  const child = spawnImpl("ngrok", ["http", `http://127.0.0.1:${port}`, "--log=stderr"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let spawnError: Error | undefined;
  let ngrokApiPort = apiPort;
  let stderrOutput = "";
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrOutput += text;
    ngrokApiPort = parseNgrokApiPort(text) ?? ngrokApiPort;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (spawnError) {
      throw new Error(`Failed to start ngrok: ${spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(formatNgrokExitError(child.exitCode, stderrOutput));
    }
    try {
      const publicUrl = await discoverNgrokUrl({ fetchImpl, expectedPort: port, apiPort: ngrokApiPort });
      return { publicUrl, process: child };
    } catch {
      await delay(250);
    }
  }

  child.kill();
  throw new Error("Timed out waiting for ngrok public URL");
}

function formatNgrokExitError(exitCode: number, stderrOutput: string): string {
  if (stderrOutput.includes("ERR_NGROK_334")) {
    return [
      "ngrok endpoint is already online in another process.",
      "Stop the existing ngrok process, run with --localhost for local replay, or pass --url <https-url> for an externally managed tunnel.",
    ].join(" ");
  }
  const errorLine = stderrOutput.split("\n").find((line) => line.startsWith("ERROR:"));
  return errorLine ? `ngrok exited with code ${exitCode}: ${errorLine.replace(/^ERROR:\s*/, "")}` : `ngrok exited with code ${exitCode}`;
}

export { parseNgrokApiPort };
