import { DEFAULTS } from "../config/defaults.js";
import type { ConfigSnapshot } from "../config/snapshot.js";

export type DelayKind = "continuation" | "failure";

export function computeRetryDelayMs(
  delayKind: DelayKind,
  attempt: number,
  snapshot: ConfigSnapshot,
): number {
  if (delayKind === "continuation") {
    return DEFAULTS.retry.continuation_delay_ms;
  }
  const base = DEFAULTS.retry.failure_base_delay_ms;
  const exp = Math.max(0, attempt - 1);
  const raw = base * Math.pow(2, exp);
  return Math.min(raw, snapshot.agent.max_retry_backoff_ms);
}
