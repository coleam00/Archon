import { useState, type ReactElement } from 'react';
import type { ListedView } from '../lib/overview-nav';

/** Two no-break spaces per level: an option draws no padding, and plain spaces collapse. */
const INDENT = String.fromCharCode(160, 160);

/** What a view shows, in one line: the root's own words, else its opener card's text. */
const lineOf = (view: ListedView): string => view.line ?? 'The whole factory, start to end';

/**
 * Every view of the overview with its card count and its one line, the open one marked,
 * indented under the view that opens it. It folds away to give the map the width. Below `md`
 * it is a select above the map instead, showing the open view and its line, so the map starts
 * in the first screen of a phone.
 */
export function OverviewSidebar({
  views,
  current,
  onOpen,
}: {
  views: readonly ListedView[];
  current: string;
  onOpen: (view: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <aside aria-label="Views" className={`flex shrink-0 flex-col gap-2 ${open ? 'md:w-48' : ''}`}>
      <label className="flex flex-col gap-1 md:hidden">
        <span className="text-console-12 font-medium uppercase tracking-wider text-text-tertiary">
          View
        </span>
        <select
          value={current}
          onChange={event => onOpen(event.target.value)}
          className="w-full rounded border border-border bg-surface px-2 py-1.5 text-console-13 text-text-primary"
        >
          {views.map(view => (
            <option key={view.id} value={view.id}>
              {`${INDENT.repeat(view.depth)}${view.label} (${view.cards.toString()})`}
            </option>
          ))}
        </select>
        <span className="text-console-12 text-text-tertiary">
          {lineOf(views.find(view => view.id === current) ?? (views[0] as ListedView))}
        </span>
      </label>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide the views' : 'Show the views'}
        onClick={() => setOpen(!open)}
        className="hidden items-center gap-2 self-start rounded px-1.5 py-0.5 text-console-12 font-medium uppercase tracking-wider text-text-tertiary hover:bg-surface-hover hover:text-text-primary md:flex"
      >
        <span aria-hidden="true">☰</span>
        {open ? 'Views' : null}
      </button>
      {open ? (
        <ul className="hidden flex-col gap-0.5 md:flex">
          {views.map(view => (
            <li key={view.id}>
              <button
                type="button"
                aria-current={view.id === current ? 'page' : undefined}
                onClick={() => onOpen(view.id)}
                style={{ paddingLeft: `${(0.5 + view.depth * 0.875).toString()}rem` }}
                className={`flex w-full flex-col gap-0.5 rounded py-1.5 pr-2 text-left transition-colors duration-150 ease-out ${
                  view.id === current
                    ? 'bg-surface-elevated text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                }`}
              >
                <span className="flex w-full items-center justify-between gap-2 text-console-13">
                  <span className="truncate">{view.label}</span>
                  <span
                    aria-label={`${view.cards.toString()} cards`}
                    className="rounded-full bg-surface-inset px-1.5 text-console-12 text-text-tertiary"
                  >
                    {view.cards}
                  </span>
                </span>
                <span data-line className="line-clamp-2 text-console-12 text-text-tertiary">
                  {lineOf(view)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
