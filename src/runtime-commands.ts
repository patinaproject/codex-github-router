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

  stdout.write("[R] Reload webhooks  [S] Settings  [Q] Quit\n");
  const previousRawMode = typeof stdin.isRaw === "boolean" ? stdin.isRaw : false;
  const setRawMode = typeof stdin.setRawMode === "function" ? (value: boolean) => stdin.setRawMode?.(value) : undefined;
  let listening = false;

  function startListening(): void {
    if (closed || listening) {
      return;
    }
    listening = true;
    setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  }

  function stopListening(): void {
    if (!listening) {
      return;
    }
    listening = false;
    stdin.off("data", onData);
    setRawMode?.(previousRawMode);
  }

  async function runWithSuspendedHotkeys(callback: () => void | Promise<void>): Promise<void> {
    stopListening();
    try {
      await callback();
    } finally {
      startListening();
    }
  }

  const onData = async (chunk: Buffer | string): Promise<void> => {
    const commands = chunk.toString("utf8").toLowerCase();
    for (const command of commands) {
      if (command === "r") {
        await onReload();
      } else if (command === "s") {
        await runWithSuspendedHotkeys(onSettings);
      } else if (command === "q") {
        close();
        await onQuit();
        return;
      }
    }
  };
  let closed = false;
  startListening();

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    stopListening();
    setRawMode?.(previousRawMode);
    stdin.pause();
  }

  return { enabled: true, close };
}
