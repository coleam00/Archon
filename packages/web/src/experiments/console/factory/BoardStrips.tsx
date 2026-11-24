import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import type { ItemName } from '../lib/ask-naming';
import { FoundByTheFactory, FoundByTheFactoryLine } from './FoundByTheFactory';
import type { SetAside } from './lib/set-aside';
import { SetAsideLine, SetAsideList } from './SetAsideStrip';

const OPENED_ID = 'board-strips-open';

/**
 * Whether the strips under the board are open. `arrived` (the board was opened on
 * `?show=found`) opens them and asks their line to scroll into view; the first toggle ends
 * that, so a person closing and reopening them is not scrolled away from the board. It lives
 * above the Pipeline/Table switch, so a switch leaves the strips as they were.
 */
export function useBoardStrips(arrived: boolean): {
  open: boolean;
  /** Scroll the strips' line into view: the board was opened on the findings. */
  arriving: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<'closed' | 'open' | 'arrived'>(arrived ? 'arrived' : 'closed');
  return {
    open: state !== 'closed',
    arriving: state === 'arrived',
    toggle: () => {
      setState(current => (current === 'closed' ? 'open' : 'closed'));
    },
  };
}

/**
 * Scroll the element into view the first time `ready` holds, once per mount. The line, not the
 * findings, is the target: it carries both strips' names, the shadow badge (Visual standard,
 * rule 10) and the toggle, and the opened strips follow it. Not per address: a Pipeline/Table
 * switch rewrites the address and must leave the page where the person has it.
 */
function useScrollOnce(ready: boolean): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!ready || scrolled.current || ref.current === null) return;
    scrolled.current = true;
    ref.current.scrollIntoView({ block: 'start' });
  }, [ready]);
  return ref;
}

interface StripsProps {
  projectId: string;
  /** The view declares `discoveries`: "Found by the factory" is one of the strips. */
  discoveries: boolean;
  setAside: readonly SetAside[];
}

/**
 * One line under the board: "Found by the factory" and "N set aside" side by side, and one
 * toggle opening both below the board ({@link BoardStripsOpened}). Nothing when neither strip
 * has anything to say.
 */
export function BoardStripsLine({
  discoveries,
  setAside,
  projectId,
  open,
  onToggle,
  arriving,
}: StripsProps & {
  open: boolean;
  onToggle: () => void;
  /**
   * The board was opened on the findings (`?show=found`) and has drawn its columns, so the line
   * sits where it stays: scroll it into view once.
   */
  arriving: boolean;
}): ReactElement | null {
  const ref = useScrollOnce(arriving);
  if (!discoveries && setAside.length === 0) return null;
  return (
    <div
      ref={ref}
      data-board-strips
      className="flex shrink-0 scroll-mt-6 flex-col gap-2 md:flex-row md:items-center md:gap-3"
    >
      {discoveries ? (
        <div className="min-w-0 md:flex-1">
          <FoundByTheFactoryLine projectId={projectId} />
        </div>
      ) : null}
      {setAside.length === 0 ? null : (
        <div className="min-w-0 md:flex-1">
          <SetAsideLine count={setAside.length} />
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={OPENED_ID}
        onClick={onToggle}
        className="shrink-0 self-start text-console-13 text-accent transition-colors duration-150 ease-out hover:text-text-primary md:self-center"
      >
        {open ? 'hide them' : 'show them'}
      </button>
    </div>
  );
}

/**
 * The strips opened: the findings and the set-aside list, in the page below the board or
 * table, never over it. The board keeps its height; the page scrolls to them.
 */
export function BoardStripsOpened({
  projectId,
  discoveries,
  setAside,
  names,
}: StripsProps & {
  names: ReadonlyMap<string, ItemName>;
}): ReactElement | null {
  if (!discoveries && setAside.length === 0) return null;
  return (
    <div
      id={OPENED_ID}
      data-board-strips-open
      className="flex shrink-0 flex-col gap-3 md:flex-row md:items-start md:pb-4"
    >
      {discoveries ? (
        <div className="min-w-0 md:flex-1">
          <FoundByTheFactory projectId={projectId} names={names} />
        </div>
      ) : null}
      {setAside.length === 0 ? null : (
        <div className="min-w-0 md:flex-1">
          <SetAsideList projectId={projectId} entries={setAside} />
        </div>
      )}
    </div>
  );
}
