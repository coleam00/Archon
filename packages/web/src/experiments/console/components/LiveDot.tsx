import type { ReactElement } from 'react';

/**
 * Broadcast-style "live" indicator for running runs. Solid inner dot with a
 * pulsing ring that radiates outward (Tailwind's `animate-ping`). Read as
 * "something is happening right now" without being noisy.
 */
export function LiveDot({ size = 10 }: { size?: number }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-[color:var(--running)] opacity-60" />
      <span
        className="relative rounded-full bg-[color:var(--running)]"
        style={{ width: size * 0.65, height: size * 0.65 }}
      />
    </span>
  );
}

/** The dot for a running run: live while its owner answers, a still dot once it does not. */
export function RunningDot({ live }: { live: boolean }): ReactElement {
  return live ? (
    <LiveDot />
  ) : (
    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--running)]" />
  );
}
