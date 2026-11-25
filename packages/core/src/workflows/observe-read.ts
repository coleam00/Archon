import { temporaryErrorKinds } from '@archon/workflows/temporary-error-kinds';
import type { ObservedItemWait } from '@archon/workflows/webhook-source-plugin';

export type WakeBinding = { workflow: string; wait: string };

/** Wake pairs a source config declares. Plugins that name none bind no overdue wait. */
export function declaredWakes(config: unknown): WakeBinding[] {
  if (typeof config !== 'object' || config === null || !('bindings' in config)) return [];
  const { bindings } = config as { bindings?: unknown };
  if (!Array.isArray(bindings)) return [];
  const wakes: WakeBinding[] = [];
  for (const binding of bindings) {
    if (typeof binding !== 'object' || binding === null || !('wake' in binding)) continue;
    const wake = (binding as { wake?: unknown }).wake;
    if (typeof wake !== 'object' || wake === null) continue;
    const workflow = (wake as { workflow?: unknown }).workflow;
    const wait = (wake as { wait?: unknown }).wait;
    if (typeof workflow === 'string' && typeof wait === 'string') wakes.push({ workflow, wait });
  }
  return wakes;
}

export function isTemporaryForgeFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return false;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' && (temporaryErrorKinds as readonly string[]).includes(kind);
}

const BACKOFF_CAP_MS = 15 * 60 * 1000;

/** The next pause after one temporary failure this pass. `previous` is the streak so far. */
export function nextBackoff(
  previous: number,
  everySeconds: number,
  now: number
): { failures: number; retryAt: number } {
  const failures = previous + 1;
  const delay = Math.min(BACKOFF_CAP_MS, Math.max(everySeconds, 60) * 1000 * 2 ** (failures - 1));
  return { failures, retryAt: now + delay };
}

export function freshOverdue(
  sourceId: string,
  wakes: readonly WakeBinding[],
  overdue: readonly { wait: ObservedItemWait; deadlineAt: string }[],
  seen: Set<string>
): { wait: ObservedItemWait; deadlineAt: string }[] {
  const fresh: { wait: ObservedItemWait; deadlineAt: string }[] = [];
  for (const entry of overdue) {
    if (
      !wakes.some(
        wake => wake.workflow === entry.wait.workflowName && wake.wait === entry.wait.event
      )
    )
      continue;
    const key = JSON.stringify([sourceId, entry.wait, entry.deadlineAt]);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  return fresh;
}
