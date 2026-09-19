import { useSyncExternalStore } from 'react';
import { ensureUtc } from './format';

/**
 * Whether wall-clock times render as 24-hour (`20:06:24`) or 12-hour
 * (`8:06:24 PM`).
 *
 * Backed by localStorage, like every other console UI preference (the rail
 * width, the sticky project view). It is a rendering choice, not data.
 *
 * The default is taken from the browser's own locale rather than hard-coded, so
 * an en-US reader gets 12-hour and an en-GB reader gets 24-hour without either
 * having to find a setting. The setting exists to override that guess, not to
 * make everyone make a choice.
 */

export type ClockFormat = '12' | '24';

const KEY = 'archon.console.clockFormat';

/** Anything unrecognised — a stale key, a hand-edited value — reads as "no preference". */
export function parseClockFormat(raw: string | null | undefined): ClockFormat | null {
  return raw === '12' || raw === '24' ? raw : null;
}

/**
 * What this browser's locale would do. `hour12` is undefined for locales with
 * no strong convention, which reads as 24-hour — the unambiguous choice.
 */
export function localeClockFormat(
  resolve: () => boolean | undefined = () =>
    new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12
): ClockFormat {
  try {
    return resolve() === true ? '12' : '24';
  } catch {
    return '24';
  }
}

const listeners = new Set<() => void>();

function read(): ClockFormat {
  try {
    return parseClockFormat(localStorage.getItem(KEY)) ?? localeClockFormat();
  } catch {
    // Storage throws with cookies disabled and in some private-browsing modes.
    return localeClockFormat();
  }
}

let current: ClockFormat | null = null;

/** The active format, cached so every timestamp on screen is not a storage read. */
export function getClockFormat(): ClockFormat {
  current ??= read();
  return current;
}

export function setClockFormat(format: ClockFormat): void {
  current = format;
  try {
    localStorage.setItem(KEY, format);
  } catch {
    // Best-effort: failing to remember the choice must not break rendering.
  }
  // Every timestamp on screen is stale the moment this changes.
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Format a wall-clock time in an explicit format.
 *
 * Kept separate from the hook so it is testable without a renderer, and so
 * non-React callers can format without subscribing.
 */
export function formatClockIn(iso: string, format: ClockFormat): string {
  const d = new Date(ensureUtc(iso));
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  if (format === '24') {
    return `${d.getHours().toString().padStart(2, '0')}:${mm}:${ss}`;
  }
  const h24 = d.getHours();
  // 0 and 12 both display as 12 — midnight is 12 AM, noon is 12 PM.
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12.toString()}:${mm}:${ss} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/**
 * A clock formatter bound to the current preference, which re-renders the
 * calling component when the preference changes.
 */
export function useClock(): (iso: string) => string {
  const format = useSyncExternalStore(subscribe, getClockFormat, getClockFormat);
  return (iso: string) => formatClockIn(iso, format);
}
