import { invalidate } from '../store/cache';

/**
 * How long the console waits before reading again while a merge state is `pending`. The
 * server answers `pending` only while its lookup still runs, so the re-reads stop on their
 * own once it settles (the forge read retries for about 7 s).
 */
export const MERGE_REREAD_MS = 3_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Reloads `key` once after `delayMs`. One timer per key however many components ask: the
 * Overview's numbers, map and lists all read the same items. A timer that fires after the
 * page closed only releases the key (`invalidate` on a key nothing subscribes to).
 */
export function scheduleReread(key: string, delayMs: number = MERGE_REREAD_MS): void {
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      invalidate(key);
    }, delayMs)
  );
}

/** Cancels every scheduled re-read; for tests, so a timer never fires into the next one. */
export function cancelRereads(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
