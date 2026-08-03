/**
 * Run status values plus the class-map helpers that express them visually.
 * Mapped to the app's semantic oklch design tokens from packages/web/src/index.css
 * so the spike renders in-brand.
 *
 * Status classes are kept separate from accent/primary classes: a primary CTA
 * must never collide with the "running" signal.
 */
export type RunStatus = 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';

export const statusLabel: Record<RunStatus, string> = {
  running: 'Running',
  paused: 'Waiting for approval',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * Status → class mappings.
 *
 * Color discipline:
 *   running   → blue  (active; pulsing strip)
 *   paused    → amber (waiting for human; pulsing dot)
 *   failed    → red
 *   completed → green (positive close; muted strip, no pulse)
 *   cancelled → grey  (muted, user-stopped)
 *
 * The running blue uses an ad-hoc arbitrary value because the spike's theme
 * introduces `--running` as a new token that isn't in the production
 * `@theme inline` map. Completed reuses the production `--success` (green)
 * at lower opacity so it signals "finished OK" without shouting.
 */
export const statusStripClass: Record<RunStatus, string> = {
  running:
    'bg-[color:var(--running)] shadow-[0_0_12px_color-mix(in_oklch,var(--running),transparent_60%)] animate-pulse',
  paused: 'bg-warning',
  failed: 'bg-error',
  completed: 'bg-success/40',
  cancelled: 'bg-text-tertiary/40',
};

export const statusTextClass: Record<RunStatus, string> = {
  running: 'text-[color:var(--running)]',
  paused: 'text-warning',
  failed: 'text-error',
  completed: 'text-success/80',
  cancelled: 'text-text-tertiary',
};

export const statusDotClass: Record<RunStatus, string> = {
  running: 'bg-[color:var(--running)]',
  paused: 'bg-warning animate-pulse',
  failed: 'bg-error',
  completed: 'bg-success',
  cancelled: 'bg-text-tertiary/60',
};
