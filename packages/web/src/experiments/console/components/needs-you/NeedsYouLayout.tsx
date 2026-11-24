import { Hourglass, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useMemo, type ReactElement } from 'react';
import { useSearchParams } from 'react-router';
import { Panel, SectionHeading } from '../../factory/document';
import {
  ANSWERED_ROWS,
  answeredRows,
  answeredToday,
  lastAsked,
  recentlySettled,
  type AnsweredRow,
  type AnsweredSource,
  type SettledAsks,
} from '../../factory/lib/answered';
import { readFailed } from '../../factory/lib/deadline';
import { readEveryItem } from '../../factory/lib/factory-items-read';
import { factoryPath, type FactoryViewListed } from '../../factory/lib/views';
import { useFactoryItems } from '../../factory/useFactoryItems';
import { useFactoryRead } from '../../factory/useFactoryRead';
import { groupBySubject } from '../../lib/ask-card';
import { askNaming, itemNames, type AskNaming } from '../../lib/ask-naming';
import { awaitingItems, needsYou, needsYouCount, type NeedsYouItem } from '../../lib/needs-you';
import type { FactoryItem } from '../../skills/factory';
import { listItemWindow, type ItemRead } from '../../skills/items';
import type { AttentionQueue } from '../../skills/runs';
import { K } from '../../store/keys';
import { useAnsweredHold, type AnsweredHold } from '../ask-card/useAnsweredHold';
import { AnsweredLately } from './AnsweredRows';
import { AwaitingSection } from './AwaitingSection';
import { ItemAskPanel } from './ItemAskPanel';
import { NeedsYouHeader } from './NeedsYouHeader';
import { NothingNeedsYou } from './NothingNeedsYou';

interface ContentProps {
  projectId: string;
  queue: AttentionQueue;
}

/**
 * Needs you's page once the queue and the views listing are read. With a factory view it
 * reads the items the Factory pages read (stage names, titles, item pages); without one, the
 * engine's items window, so a project with no factory has its history too. Two components,
 * not one hook: the factory read answers 404 without a view.
 */
export function NeedsYouContent({
  view,
  ...props
}: ContentProps & { view: FactoryViewListed | undefined }): ReactElement {
  return view === undefined ? (
    <WindowNeedsYou {...props} />
  ) : (
    <FactoryNeedsYou {...props} view={view} />
  );
}

function FactoryNeedsYou({
  projectId,
  queue,
  view,
}: ContentProps & { view: FactoryViewListed }): ReactElement {
  const items = useFactoryItems(projectId);
  const names = useMemo(() => itemNames(items.data), [items.data]);
  const awaiting = useMemo(() => awaitingItems(items.data ?? []), [items.data]);
  return (
    <NeedsYouLayout
      projectId={projectId}
      queue={queue}
      naming={askNaming(projectId, view, names)}
      declaration={view.declaration}
      items={items.data}
      awaiting={awaiting}
      failed={readFailed(items.error)}
      itemHref={row => factoryPath(projectId, `/items/${encodeURIComponent(row.itemKey)}`)}
      boardHref={factoryPath(projectId, '/board')}
    />
  );
}

function WindowNeedsYou({ projectId, queue }: ContentProps): ReactElement {
  // Under the `factory-items:<id>` prefix, so an ask opening or closing reads it again.
  const items = useFactoryRead<ItemRead[]>(K.projectItems(projectId), within =>
    readEveryItem(projectId, listItemWindow, within)
  );
  // The engine's read carries links, so a member names its work order without a view too.
  const names = useMemo(() => itemNames(items.data), [items.data]);
  return (
    <NeedsYouLayout
      projectId={projectId}
      queue={queue}
      naming={askNaming(projectId, undefined, names)}
      declaration={null}
      items={items.data}
      awaiting={[]}
      failed={readFailed(items.error)}
      itemHref={row =>
        row.restart === null ? undefined : `/console/p/${projectId}/r/${row.restart.runId}`
      }
      boardHref={undefined}
    />
  );
}

/**
 * What the history read gives the page. While it is unread the figures are undefined; when it
 * failed, `today` is null (unknown, never 0) and `lastAsked` stays undefined, so the empty
 * state never claims nothing was ever asked.
 */
function history(
  declaration: FactoryViewListed['declaration'] | null,
  items: readonly AnsweredSource[] | undefined,
  failed: Error | undefined,
  now: Date
): {
  settled: SettledAsks[] | undefined;
  today: number | null | undefined;
  lastAsked: string | null | undefined;
} {
  if (items === undefined)
    return {
      settled: undefined,
      today: failed === undefined ? undefined : null,
      lastAsked: undefined,
    };
  const settled = recentlySettled(declaration, items, ANSWERED_ROWS);
  return { settled, today: answeredToday(items, now), lastAsked: lastAsked(settled) };
}

// The aside spans the rows the main column's sections take (`lg:grid-flow-row-dense` puts it
// beside the first), so a tall Open asks section does not push it down and a tall aside does
// not hold Paused waits below it.
const ASIDE_ROWS = ['lg:row-span-1', 'lg:row-span-1', 'lg:row-span-2', 'lg:row-span-3'] as const;

/**
 * The page (owner changes 5 and 9): the header band across the width, then a 2:1 grid, the
 * open asks, paused waits and the factory items waiting on you (or the empty state) in the main
 * column and Answered lately beside them; one column at 390 px. The sections key on the held asks, not the live count, so
 * answering the last ask keeps "Answered: X" in place before the empty state.
 */
function NeedsYouLayout({
  projectId,
  queue,
  naming,
  declaration,
  items,
  awaiting,
  failed,
  itemHref,
  boardHref,
}: ContentProps & {
  naming: AskNaming;
  declaration: FactoryViewListed['declaration'] | null;
  items: readonly AnsweredSource[] | undefined;
  /** The factory items waiting on you with no ask open (`awaitingItems`); none without a view. */
  awaiting: readonly FactoryItem[];
  failed: Error | undefined;
  itemHref: (row: AnsweredRow) => string | undefined;
  boardHref: string | undefined;
}): ReactElement {
  const live = useMemo(() => needsYou(queue.items), [queue.items]);
  const hold = useAnsweredHold(live);
  useBringForward(hold.asks);
  const now = Date.now();
  const read = history(declaration, items, failed, new Date(now));
  const open = hold.asks.filter(ask => ask.kind !== 'overdue_wait');
  const paused = hold.asks.filter(ask => ask.kind === 'overdue_wait');
  const shared = { projectId, queue, naming, hold };
  const sections = [open.length, paused.length, awaiting.length].filter(n => n > 0).length;
  return (
    <div
      data-doc-page=""
      className="grid grid-cols-1 items-start gap-6 lg:grid-flow-row-dense lg:grid-cols-3"
    >
      <NeedsYouHeader
        count={needsYouCount(queue, awaiting)}
        awaiting={awaiting.length}
        live={live}
        answeredToday={read.today}
        now={now}
      />
      <DegradedRuns queue={queue} />
      {hold.asks.length === 0 && awaiting.length === 0 ? (
        <NothingNeedsYou
          projectId={projectId}
          lastAsked={read.lastAsked}
          loading={items === undefined && failed === undefined}
          boardHref={boardHref}
          className="lg:col-span-2"
        />
      ) : null}
      {open.length === 0 ? null : <AskSection kind="open" asks={open} {...shared} />}
      {paused.length === 0 ? null : <AskSection kind="paused" asks={paused} {...shared} />}
      {awaiting.length === 0 ? null : <AwaitingSection projectId={projectId} items={awaiting} />}
      <AnsweredLately
        projectId={projectId}
        rows={read.settled === undefined ? undefined : answeredRows(read.settled)}
        failed={failed}
        href={itemHref}
        className={`lg:col-start-3 ${ASIDE_ROWS[sections]}`}
      />
    </div>
  );
}

/** Paused runs the queue could not read, so what they wait on is not listed. */
function DegradedRuns({ queue }: { queue: AttentionQueue }): ReactElement | null {
  const count = queue.degraded.length;
  if (count === 0) return null;
  return (
    <Panel role="alert" tone="var(--warning)" bar="left" className="p-4 pl-5 lg:col-span-3">
      <p className="text-console-13 text-warning">
        {count === 1
          ? 'One paused run could not be read, so what it waits on is not listed.'
          : `${count.toString()} paused runs could not be read, so what they wait on is not listed.`}
      </p>
    </Panel>
  );
}

const SECTION = {
  open: { icon: MessageCircleQuestion, eyebrow: 'Open asks', title: 'Waiting on your answer' },
  paused: { icon: Hourglass, eyebrow: 'Paused', title: 'Waiting past their deadline' },
} as const;

/** Open asks, or paused waits: a heading row in the needs-you colour, then a panel per item. */
function AskSection({
  kind,
  asks,
  projectId,
  queue,
  naming,
  hold,
}: {
  kind: 'open' | 'paused';
  asks: readonly NeedsYouItem[];
  projectId: string;
  queue: AttentionQueue;
  naming: AskNaming;
  hold: AnsweredHold;
}): ReactElement {
  const words = SECTION[kind];
  const id = `needs-you-${kind}`;
  return (
    <section
      data-doc-section=""
      data-needs-you={kind}
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 lg:col-span-2"
    >
      <SectionHeading
        id={id}
        icon={words.icon}
        eyebrow={words.eyebrow}
        title={words.title}
        tone="var(--warning)"
        count={asks.length}
      />
      {groupBySubject(asks).map(group => (
        <ItemAskPanel
          key={group.key}
          kind={kind}
          projectId={projectId}
          subject={naming.subject(group.first)}
          asks={group.asks}
          queue={queue}
          naming={naming}
          hold={hold}
        />
      ))}
    </section>
  );
}

/** `?ask=<ref>` (the Overview's Open): scroll to that card and focus it, once it is drawn. */
function useBringForward(asks: readonly NeedsYouItem[]): void {
  const [params] = useSearchParams();
  const ref = params.get('ask');
  const present = ref !== null && asks.some(ask => ask.ref === ref);
  useEffect(() => {
    if (!present) return;
    const card = [...document.querySelectorAll<HTMLElement>('[data-ask]')].find(
      element => element.dataset.ask === ref
    );
    card?.scrollIntoView?.({ block: 'center' });
    card?.focus({ preventScroll: true });
  }, [present, ref]);
}
