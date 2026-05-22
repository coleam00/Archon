/** Formatting helpers for the console. Pure functions, no React. */

export function shortRunId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/** HH:MM:SS (or MM:SS under an hour). Tabular numerals recommended at call site. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function elapsedSince(startIso: string, endIso?: string): number {
  const start = new Date(startIso).getTime();
  const end = endIso !== undefined ? new Date(endIso).getTime() : Date.now();
  return (end - start) / 1000;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  const d = Math.floor((now - t) / 1000);
  if (d < 5) return 'just now';
  if (d < 60) return `${d.toString()}s ago`;
  if (d < 3600) return `${Math.floor(d / 60).toString()}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600).toString()}h ago`;
  return `${Math.floor(d / 86400).toString()}d ago`;
}

/**
 * Offset from a run's start, e.g. `+04:12`. When watching a run this is far
 * more useful than a wall-clock timestamp — and it sidesteps timezone drift.
 * Falls back to wall-clock HH:MM:SS if the baseline is invalid.
 */
export function formatRelativeToBaseline(eventIso: string, baselineIso: string | null): string {
  if (baselineIso === null) return formatClock(eventIso);
  const base = new Date(baselineIso).getTime();
  const t = new Date(eventIso).getTime();
  if (Number.isNaN(base) || Number.isNaN(t)) return formatClock(eventIso);
  const delta = Math.max(0, Math.floor((t - base) / 1000));
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  const s = delta % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return h > 0 ? `+${pad(h)}:${pad(m)}:${pad(s)}` : `+${pad(m)}:${pad(s)}`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Compact USD cost — under a dollar shows cents, over a dollar shows two
 * decimals. Sub-cent values still surface (rounded to 4 decimals) so cheap
 * runs don't look free.
 */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Compact project subtitle. Prefer the local filesystem path because it's
 * what the user actually navigates to (and what worktrees / artifacts hang
 * off), and because after a rename the owner/repo derivation often reads as
 * a duplicate of the original name. `/Users/<name>/` and `/home/<name>/`
 * are shortened to `~/` for readability.
 */
export function formatProjectLocator(project: {
  repositoryUrl: string | null;
  path: string;
}): string {
  if (project.path.length > 0) {
    return project.path.replace(/^\/(?:Users|home)\/[^/]+\//, '~/');
  }
  if (project.repositoryUrl !== null && project.repositoryUrl.length > 0) {
    const m = /[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/.exec(project.repositoryUrl);
    if (m !== null) return m[1];
    return project.repositoryUrl;
  }
  return '';
}
