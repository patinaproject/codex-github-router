import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

export function attachRuntimeCommands({
  stdin,
  stdout,
  onReload,
  onSettings,
  onQuit,
}: {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  onReload: () => void | Promise<void>;
  onSettings: () => void | Promise<void>;
  onQuit: () => void | Promise<void>;
}): { enabled: boolean; close: () => void } {
  if (!stdin.isTTY) {
    return { enabled: false, close() {} };
  }

  stdout.write("[R] Reload webhooks  [S] Show settings  [Q] Quit\n");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on("line", async (line) => {
    const command = line.trim().toLowerCase();
    if (command === "r") {
      await onReload();
    } else if (command === "s") {
      await onSettings();
    } else if (command === "q") {
      await onQuit();
      rl.close();
    }
  });

  return { enabled: true, close: () => rl.close() };
}
