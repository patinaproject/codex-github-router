export type DeliveryAttemptPhase =
  | "spawning"
  | "initializing"
  | "resuming"
  | "queued"
  | "starting"
  | "waiting"
  | "compacting";

export interface CodexTurnResult {
  turnId: string;
  agentMessage?: string | undefined;
}

export type DeliveryAttemptResult =
  | { status: "completed"; turn: CodexTurnResult }
  | { status: "timed-out"; phase: DeliveryAttemptPhase; error: Error };

export async function deliverWithTimeoutRetry({
  attempt,
  env,
  log,
  threadId,
}: {
  attempt: () => Promise<DeliveryAttemptResult>;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  threadId: string;
}): Promise<CodexTurnResult> {
  const retries = retrySetting(env, "CODEX_APP_SERVER_TIMEOUT_RETRIES", 1);
  const delayMs = retrySetting(env, "CODEX_APP_SERVER_TIMEOUT_RETRY_DELAY_MS", 1000, 2 ** 31 - 1);
  const total = retries + 1;
  for (let number = 1; ; number += 1) {
    log(`thread ${threadId} ${number > 1 ? "retry " : ""}attempt ${number}/${total} starting`);
    const result = await attempt();
    if (result.status === "completed") {
      log(`thread ${threadId} attempt ${number}/${total} completed turn ${result.turn.turnId}`);
      return result.turn;
    }
    const detail = result.phase === "queued" ? "thread remained active" : `phase=${result.phase}`;
    log(`thread ${threadId} attempt ${number}/${total} timed out; ${detail}`);
    if (number === total) {
      throw new Error(`${result.error.message}; timeout attempts exhausted (${number}/${total}); ${detail}`);
    }
    log(`thread ${threadId} retry attempt ${number + 1}/${total} scheduled after ${delayMs}ms`);
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function retrySetting(env: NodeJS.ProcessEnv, name: string, defaultValue: number, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  const raw = env[name];
  const value = raw === undefined ? defaultValue : Number(raw);
  if (raw?.trim() === "" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}
