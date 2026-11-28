import type { ReactElement } from 'react';
import type { StageRead } from '../lib/map-live';

/** A state chip: the state's colour as text on its soft background (rule 5). */
const CHIP_CLASS = {
  running: 'bg-[color:var(--running-soft)] text-[color:var(--running)]',
  'needs-you': 'bg-[color:var(--warning-soft)] text-warning',
  waiting: 'bg-surface-inset text-text-tertiary',
} as const;

/**
 * A chip: a pill in the Label size, the state's colour on its soft background (rule 5), its
 * count in tabular figures so it does not jitter as it changes.
 */
const CHIP =
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-console-12 tabular-nums';

/** The words a stage's chips say, for its link's accessible name. */
export function chipWords(live: StageRead): string {
  if (live === 'loading') return 'loading';
  if (live === 'failed') return 'items could not be read';
  const parts = [`${live.items.length.toString()} here`];
  if (live.working > 0) parts.push(`${live.working.toString()} being worked`);
  if (live.needYou.length > 0) parts.push(needYouWords(live.needYou.length));
  return parts.join(', ');
}

const needYouWords = (n: number): string => `${n.toString()} ${n === 1 ? 'needs' : 'need'} you`;

/**
 * How many sit on a stage: a skeleton bar until the items are read (never "0 here"), nothing
 * once the first read failed (the alert above the map says why) or when nothing sits there,
 * else "N here", in the running colour
 * with its dot pulsing while a run works one (rule 7), in the waiting colour otherwise.
 */
export function HereChip({ live }: { live: StageRead }): ReactElement | null {
  if (live === 'failed') return null;
  if (live === 'loading')
    return (
      <span data-chip="loading" className="inline-flex h-5 shrink-0 items-center">
        <span
          aria-hidden="true"
          className="h-3 w-12 rounded bg-surface-elevated motion-safe:animate-pulse"
        />
        <span className="sr-only">Loading</span>
      </span>
    );
  const here = live.items.length;
  if (here === 0) return null;
  const running = live.working > 0;
  return (
    <span data-chip="here" className={`${CHIP} ${CHIP_CLASS[running ? 'running' : 'waiting']}`}>
      {running ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-[color:var(--running)] motion-safe:animate-pulse"
        />
      ) : null}
      {here} here
    </span>
  );
}

/** How many on a stage need a person, soft like every counting chip (rule 5); else nothing. */
export function NeedsYouChip({ live }: { live: StageRead }): ReactElement | null {
  if (typeof live === 'string' || live.needYou.length === 0) return null;
  return (
    <span data-chip="need-you" className={`${CHIP} ${CHIP_CLASS['needs-you']}`}>
      {needYouWords(live.needYou.length)}
    </span>
  );
}
