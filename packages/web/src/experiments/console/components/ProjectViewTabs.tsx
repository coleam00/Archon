import { useEffect, useRef, type ReactElement } from 'react';
import { factoryTabShown } from '../factory/lib/views';
import { useFactoryItems } from '../factory/useFactoryItems';
import { useFactoryViews } from '../factory/useFactoryViews';
import { needsYouCount } from '../lib/needs-you';
import type { AttentionQueue } from '../skills/runs';
import { useProjectAttention } from './ProjectAttention';
import { TabLink } from './TabLink';

type ProjectView = 'needs-you' | 'runs' | 'chat' | 'metrics' | 'factory';

interface ProjectViewTabsProps {
  projectId: string;
  active: ProjectView;
}

const TABS: readonly { key: ProjectView; label: string; suffix: string }[] = [
  { key: 'needs-you', label: 'Needs you', suffix: '/needs-you' },
  { key: 'runs', label: 'Runs', suffix: '' },
  { key: 'chat', label: 'Chat', suffix: '/chat' },
  { key: 'metrics', label: 'Metrics', suffix: '/metrics' },
];
const FACTORY_TAB = { key: 'factory', label: 'Factory', suffix: '/factory' } as const;

/**
 * Needs you | Runs | Chat | Metrics tab control under a project, then Factory when a factory
 * view applies to the project. Needs you carries how many things need a person (`needsYouCount`:
 * the asks and waits, and on a factory project the items waiting on you), in the needs-you
 * colour, while above zero. Each tab is a `TabLink` (brand-bar underline on the active one),
 * on one row, which scrolls sideways on a phone rather than wrap and keeps the active tab in
 * view (no scrollbar drawn; the bottom padding holds the active tab's brand bar, which a
 * scrolling row would clip). Only meaningful when a project is scoped, so it is rendered only
 * under `ProjectAttentionLayout`, never on the All-projects view.
 */
export function ProjectViewTabs({ projectId, active }: ProjectViewTabsProps): ReactElement {
  const { data: factoryViews } = useFactoryViews(projectId);
  const attention = useProjectAttention();
  const factory = factoryTabShown(factoryViews);
  const tabs = factory ? [...TABS, FACTORY_TAB] : TABS;
  const row = useRef<HTMLDivElement>(null);
  // Bring the active tab into view, and again whenever its place changes: the row's width (a
  // phone turned), or the tab's left edge or width (the web font arriving, the Needs-you badge
  // widening a tab before it). A change after it does not move it, so a person's own scroll is
  // never undone. Re-run on the tab count to observe a tab that joins late (Factory). The row
  // scrolls itself; scrollIntoView would scroll the page as well.
  useEffect(() => {
    const el = row.current;
    if (el === null) return;
    let seen = '';
    const reveal = (): void => {
      const tab = el.querySelector<HTMLElement>('[aria-current="page"]');
      const place = [el.clientWidth, tab?.offsetLeft, tab?.offsetWidth].join(' ');
      if (tab === null || place === seen) return;
      seen = place;
      if (tab.offsetLeft < el.scrollLeft) el.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth)
        el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth;
    };
    reveal();
    // Where no ResizeObserver is installed (a test DOM may set none), it reveals on mount alone.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reveal);
    for (const watched of [el, ...el.children]) observer.observe(watched);
    return (): void => observer.disconnect();
  }, [active, tabs.length]);
  return (
    <div
      ref={row}
      className="tab-row relative flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto pb-0.5"
    >
      {tabs.map(({ key, label, suffix }) => (
        <TabLink key={key} to={`/console/p/${projectId}${suffix}`} active={key === active}>
          {label}
          {key !== 'needs-you' || attention.data === undefined ? null : factory ? (
            <FactoryWaitingBadge projectId={projectId} queue={attention.data} />
          ) : (
            <WaitingBadge count={needsYouCount(attention.data)} />
          )}
        </TabLink>
      ))}
    </div>
  );
}

/**
 * The badge on a factory project: the factory's items read too, the one the Factory pages and
 * Needs you read (cached), so it counts the items waiting on you as they do. Only a project
 * the Factory tab shows for reads it: the read answers 404 without a view.
 */
function FactoryWaitingBadge({
  projectId,
  queue,
}: {
  projectId: string;
  queue: AttentionQueue;
}): ReactElement | null {
  const items = useFactoryItems(projectId);
  return <WaitingBadge count={needsYouCount(queue, items.data)} />;
}

/**
 * How many wait on a person, in the needs-you colour; nothing while none does. A chip that
 * counts needs-you stays soft (Visual standard, rule 5): the filled pill is a card's own Needs
 * you state.
 */
function WaitingBadge({ count }: { count: number }): ReactElement | null {
  if (count === 0) return null;
  return (
    <span
      aria-label={`${count.toString()} waiting`}
      className="rounded-full bg-[color:var(--warning-soft)] px-1.5 text-console-12 font-semibold normal-case tabular-nums tracking-normal text-warning"
    >
      {count}
    </span>
  );
}
