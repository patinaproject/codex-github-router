import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function githubGet(apiPath: string | undefined): Promise<unknown> {
  if (!apiPath?.startsWith("/")) {
    throw new Error("GitHub API path must start with /");
  }
  const { stdout } = await execFileAsync("gh", ["api", apiPath], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
