import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";

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
}: {
  fetchImpl?: typeof fetch;
  expectedPort?: number;
} = {}): Promise<string> {
  const response = await fetchImpl(NGROK_API_URL);
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

export async function startNgrokTunnel({
  port,
  stderr,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  timeoutMs = 10000,
}: {
  port: number;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}): Promise<{ publicUrl: string; process: ChildProcess }> {
  const child = spawnImpl("ngrok", ["http", String(port), "--log=stderr"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk) => {
    stderr?.write(chunk);
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (spawnError) {
      throw new Error(`Failed to start ngrok: ${spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`ngrok exited with code ${child.exitCode}`);
    }
    try {
      const publicUrl = await discoverNgrokUrl({ fetchImpl, expectedPort: port });
      return { publicUrl, process: child };
    } catch {
      await delay(250);
    }
  }

  child.kill();
  throw new Error("Timed out waiting for ngrok public URL");
}
