/**
 * The items set aside, under the board (ported from v1's `SetAsideStrip.tsx` and
 * `BoardStrips.tsx`, `origin/main`): one line, "N set aside", with a toggle that opens the
 * list below it, so nothing covers the board. Each row: the key, the title, why it is set
 * aside and when its last run ended. A row opens the item's run log, as a card does. Nothing
 * when none is set aside.
 */
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { formatDateTime } from '../lib/format';
import { runPath, runToOpen } from '../routes/board/standing';
import { useForgeTitles } from './FactoryCards';
import type { SetAside } from './lib/board-numbers';
import { itemTitle } from './lib/item-card';

const LIST_ID = 'set-aside-list';

export function SetAsideStrip({
  projectId,
  entries,
}: {
  projectId: string;
  entries: readonly SetAside[];
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <section data-set-aside className="mb-6 flex flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        <h2 className="min-w-0 rounded-console-12 border border-border bg-surface px-4 py-2 text-console-15 font-semibold text-text-primary md:flex-1">
          <span data-set-aside-count className="tabular-nums">
            {entries.length}
          </span>{' '}
          set aside
        </h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={LIST_ID}
          onClick={() => {
            setOpen(was => !was);
          }}
          className="shrink-0 self-start text-console-13 text-accent motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:text-text-primary md:self-center"
        >
          {open ? 'hide them' : 'show them'}
        </button>
      </div>
      {open ? <SetAsideList projectId={projectId} entries={entries} /> : null}
    </section>
  );
}

function SetAsideList({
  projectId,
  entries,
}: {
  projectId: string;
  entries: readonly SetAside[];
}): ReactElement {
  // Read only once the list opens, so a closed strip costs no forge read.
  const titles = useForgeTitles(
    projectId,
    entries.map(entry => entry.read)
  );
  return (
    <ul
      id={LIST_ID}
      className="flex flex-col gap-2 rounded-console-12 border border-border bg-surface px-4 py-3"
    >
      {entries.map(entry => {
        const { title, titleIsKey, keyText } = itemTitle(entry.read, titles);
        const run = runToOpen(entry.read);
        return (
          <li
            key={entry.read.item.id}
            data-item={entry.read.item.key}
            className="flex min-w-0 flex-col text-console-13"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              {run === undefined ? (
                <span className="shrink-0 font-mono text-console-12 text-text-tertiary">
                  {keyText}
                </span>
              ) : (
                <Link
                  to={runPath(projectId, run.id)}
                  aria-label={`${keyText}: open its run log`}
                  className="shrink-0 font-mono text-console-12 text-accent-bright hover:underline"
                >
                  {keyText}
                </Link>
              )}
              {titleIsKey ? null : (
                <span title={title} className="min-w-0 truncate text-text-primary">
                  {title}
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span data-set-aside-why className="text-text-secondary">
                {entry.why}
              </span>
              {entry.since === null ? null : (
                <span className="whitespace-nowrap text-console-12 text-text-tertiary">
                  {formatDateTime(entry.since)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
