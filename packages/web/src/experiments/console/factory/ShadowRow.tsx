import { useState, type ReactElement } from 'react';
import type { TimelineShadow } from './lib/timeline';
import { ShadowBadge } from './ShadowBadge';

/**
 * One shadow decision in its stage's panel of the item's story (rule 10): the badge, what decided
 * it, and what it would have done, in the tertiary text colour and never a state colour,
 * since nothing acted on it. Its why, or the failed checks' output, opens below.
 */
export function ShadowRow({ shadow }: { shadow: TimelineShadow }): ReactElement {
  const [open, setOpen] = useState(false);
  const { words } = shadow;
  return (
    <li data-shadow={shadow.label} className="flex min-w-0 flex-col gap-1">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-console-13 text-text-tertiary">
        <ShadowBadge />
        <span>
          {shadow.label}
          {shadow.round === null ? '' : ` · round ${shadow.round.toString()}`}
        </span>
        <span className={words.mono ? 'font-mono' : ''}>{words.line}</span>
        {words.detail === null ? null : (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="rounded text-console-12 font-medium text-text-tertiary hover:text-text-primary"
          >
            {open ? 'Less' : 'Why'}
          </button>
        )}
      </p>
      {open && words.detail !== null ? (
        <p className="whitespace-pre-line break-words text-console-13 text-text-tertiary">
          {words.detail}
        </p>
      ) : null}
    </li>
  );
}
