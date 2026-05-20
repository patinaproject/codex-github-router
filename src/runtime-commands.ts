import type { Readable, Writable } from "node:stream";

export function attachRuntimeCommands({
  stdin,
  stdout,
  onReload,
  onSettings,
  onQuit,
}: {
  stdin: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: Writable;
  onReload: () => void | Promise<void>;
  onSettings: () => void | Promise<void>;
  onQuit: () => void | Promise<void>;
}): { enabled: boolean; close: () => void } {
  if (!stdin.isTTY) {
    return { enabled: false, close() {} };
  }

  stdout.write("[R] Reload webhooks  [S] Show settings  [Q] Quit\n");
  const previousRawMode = typeof stdin.isRaw === "boolean" ? stdin.isRaw : false;
  const setRawMode = typeof stdin.setRawMode === "function" ? (value: boolean) => stdin.setRawMode?.(value) : undefined;
  setRawMode?.(true);
  stdin.resume();

  const onData = async (chunk: Buffer | string): Promise<void> => {
    const commands = chunk.toString("utf8").toLowerCase();
    for (const command of commands) {
      if (command === "r") {
        await onReload();
      } else if (command === "s") {
        await onSettings();
      } else if (command === "q") {
        close();
        await onQuit();
        return;
      }
    }
  };
  stdin.on("data", onData);

  function close(): void {
    stdin.off("data", onData);
    setRawMode?.(previousRawMode);
  }

  return { enabled: true, close };
}
