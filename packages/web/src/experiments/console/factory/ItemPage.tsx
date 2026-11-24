import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import { displayItemKey } from './lib/item-key';
import { useParams } from 'react-router';
import { BookOpen, Info } from 'lucide-react';
import { SkeletonBlock, SkeletonGroup, SkeletonLine } from '../components/Skeleton';
import * as skill from '../skills';
import type { FactoryItem, FactoryItemDetail } from '../skills/factory';
import { useProjectAttention } from '../components/ProjectAttention';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import { useFactoryRead } from './useFactoryRead';
import { BackLink } from './BackLink';
import { FactoryFrame } from './FactoryFrame';
import { Panel, SectionHeading } from './document';
import { ItemBand } from './ItemBand';
import { ItemJourney } from './ItemJourney';
import { ItemStory } from './ItemStory';
import { ItemAnswers, ItemLinks } from './ItemRecords';
import { isNoSuchItem, useWorkOrders, WorkOrderOnly } from './ItemWorkOrder';
import { itemPill } from './lib/board';
import { mergePending } from './lib/merge-pending';
import { itemAsks } from '../lib/needs-you';
import { itemColumn, placementInput, stageIdOf } from './lib/placement';
import { itemJourney } from './lib/item-journey';
import { itemStory } from './lib/item-story';
import { buildTimeline } from './lib/timeline';
import { membershipOf } from './lib/work-orders';
import { factoryPath, type FactoryViewListed } from './lib/views';
import { scheduleReread } from './merge-reread';
import { FactoryLoading } from './FactoryLoading';
import { ItemNotFound } from './ItemMissing';
import { readFailure } from './lib/read-failure';
import { ReadFailure } from './ReadFailure';
import { useReadRetry } from './useReadRetry';
import { useFactoryItemsRead } from './useFactoryItems';
import { itemNames } from '../lib/ask-naming';

/** `/console/p/:projectId/factory/items/:key`: one item, all of it. */
export function ItemPage(): ReactElement {
  return <FactoryFrame section={null}>{view => <ItemBody view={view} />}</FactoryFrame>;
}

function ItemBody({ view }: { view: FactoryViewListed }): ReactElement {
  const { projectId = '', key = '' } = useParams<{ projectId: string; key: string }>();
  // Under the `factory-items` prefix, so the dashboard SSE refreshes it on every run event.
  const itemKey = K.factoryItem(projectId, key);
  const read = useFactoryRead<FactoryItemDetail>(itemKey, within =>
    within(signal => skill.getFactoryItem({ codebaseId: projectId, key }, { signal }))
  );
  // As `useFactoryItems`: read again while the server is still asking whether it merged.
  const { data, error } = read;
  useEffect(() => {
    if (data !== undefined && mergePending(data.item)) scheduleReread(itemKey);
  }, [data, error, itemKey]);
  return (
    <div className="flex flex-col gap-6">
      <BackLink to={factoryPath(projectId)} label="Back to the overview" />
      <ItemRead view={view} projectId={projectId} itemKey={key} read={read} />
    </div>
  );
}

function ItemRead({
  view,
  projectId,
  itemKey,
  read,
}: {
  view: FactoryViewListed;
  projectId: string;
  itemKey: string;
  read: EntityView<FactoryItemDetail>;
}): ReactNode {
  const { data } = read;
  const attention = useProjectAttention();
  const orders = useWorkOrders(
    view.declaration,
    projectId,
    data === undefined ? undefined : { key: itemKey, members: incomingMembers(data.item) }
  );
  const order = orders.orders?.find(entry => entry.key === itemKey);
  // The same items read the orders come from: a linked split member reads under its order.
  const items = useFactoryItemsRead(projectId).data?.items;
  const names = useMemo(() => itemNames(items), [items]);
  // The stage the item sat in on the last read: a run on a step no stage names stays there,
  // as on the board and the map.
  const previous = useRef<{ key: string; stage: string | undefined } | null>(null);
  const column =
    data === undefined
      ? undefined
      : itemColumn(
          view.declaration,
          placementInput(data.item, new Map(data.runs.map(run => [run.runId, run]))),
          previous.current?.key === itemKey ? previous.current.stage : undefined
        );
  useEffect(() => {
    if (column !== undefined) previous.current = { key: itemKey, stage: stageIdOf(column) };
  }, [column, itemKey]);
  if (data === undefined)
    return (
      <ItemUnread
        key={itemKey}
        projectId={projectId}
        itemKey={itemKey}
        read={read}
        orders={orders}
      />
    );
  const asks = itemAsks(data.item, attention.data?.items ?? []);
  const declaration = view.declaration;
  // The placement every view shares, and the board's pill, so the band says what the item's
  // card says and the strip lights the card's column.
  const landed = stageIdOf(column ?? null) === declaration.landed.stage;
  const now = Date.now();
  const journey = itemJourney(declaration, data, column ?? null, now);
  const timeline = buildTimeline(declaration, data);
  const state = itemPill(declaration, data.item, landed);
  return (
    <div data-doc-page="" className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
      <ItemBand
        detail={data}
        pill={state.pill}
        pillLabel={state.pillLabel}
        column={column ?? null}
        journey={journey}
        workOrder={
          data.item.runs.length === 0 &&
          (order !== undefined || incomingMembers(data.item).length > 0)
        }
      />
      {data.item.runs.length === 0 ? null : <ItemJourney journey={journey} />}
      <section
        data-doc-section=""
        aria-labelledby="item-story"
        className="flex min-w-0 flex-col gap-4"
      >
        <SectionHeading
          id="item-story"
          icon={BookOpen}
          eyebrow="What happened"
          title="The story"
          tone="var(--text-tertiary)"
        />
        <ItemStory
          projectId={projectId}
          view={view}
          panels={itemStory(declaration, projectId, data, timeline, now)}
          asks={asks}
          questions={data.item.questions.length}
          awaits={state.pill === 'awaits' ? (data.item.progress?.awaits ?? null) : null}
        />
      </section>
      <section
        data-doc-section=""
        aria-labelledby="item-about"
        className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start"
      >
        <SectionHeading
          id="item-about"
          icon={Info}
          eyebrow="Around it"
          title="About this item"
          tone="var(--text-tertiary)"
        />
        <div className="flex flex-col gap-4">
          <ItemLinks
            projectId={projectId}
            itemKey={data.item.item.key}
            names={names}
            links={data.item.links}
            membership={membershipOf(data.item)}
            order={order}
          />
          <ItemAnswers projectId={projectId} answers={data.item.answers} />
          <Degraded degraded={data.item.degraded} />
        </div>
      </section>
    </div>
  );
}

/** The keys of the items an active `part_of` link joins to this one: its members, by its own read. */
function incomingMembers(item: FactoryItemDetail['item']): string[] {
  return item.links
    .filter(link => link.kind === 'part_of' && link.direction === 'incoming' && link.ended === null)
    .map(link => link.other.key);
}

/**
 * The page while the item read has no value: loading, why it failed with a Retry, or that there
 * is no such item. Keyed by the item, so a held failure of another key is never shown.
 */
function ItemUnread({
  projectId,
  itemKey,
  read,
  orders,
}: {
  projectId: string;
  itemKey: string;
  read: EntityView<FactoryItemDetail>;
  orders: ReturnType<typeof useWorkOrders>;
}): ReactElement {
  const { failed, retry } = useReadRetry(read);
  if (isNoSuchItem(failed))
    return <NoSuchItem projectId={projectId} itemKey={itemKey} read={read} orders={orders} />;
  if (failed !== undefined)
    return (
      <ReadFailure retry={retry}>
        Item <span className="font-mono">{displayItemKey(itemKey, null)}</span> could not be read:{' '}
        {readFailure(failed)}
      </ReadFailure>
    );
  return <ItemSkeleton read={read} />;
}

/**
 * The item read answered 404. A work order only a member's order run named has no item row, so
 * the page is the order's, from the items read. Until that read lands the page cannot say there
 * is no item, and if it failed, it says the item could not be checked, with a Retry.
 */
function NoSuchItem({
  projectId,
  itemKey,
  read,
  orders,
}: {
  projectId: string;
  itemKey: string;
  read: EntityView<FactoryItemDetail>;
  orders: ReturnType<typeof useWorkOrders>;
}): ReactElement {
  if (orders.orders === undefined)
    return orders.failed === undefined ? (
      <ItemSkeleton read={read} />
    ) : (
      <ReadFailure retry={orders.retry}>
        Item <span className="font-mono">{displayItemKey(itemKey, null)}</span> could not be
        checked: the items could not be read to look for it: {readFailure(orders.failed)}
      </ReadFailure>
    );
  const order = orders.orders.find(entry => entry.key === itemKey);
  if (order !== undefined) return <WorkOrderOnly projectId={projectId} order={order} />;
  return <ItemNotFound projectId={projectId} itemKey={itemKey} />;
}

/** The item page's shape while it loads (rule 6): the header's lines and pill, three runs. */
function ItemSkeleton({ read }: { read: EntityView<FactoryItemDetail> }): ReactElement {
  return (
    <FactoryLoading read={read}>
      <SkeletonGroup label="Loading the item" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <SkeletonLine width="short" />
          <SkeletonLine />
          <SkeletonBlock height="h-6" />
        </div>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map(index => (
            <SkeletonBlock key={index} height="h-16" />
          ))}
        </div>
      </SkeletonGroup>
    </FactoryLoading>
  );
}

/** Each part of the item that could not be read, one muted line each. */
function Degraded({ degraded }: { degraded: FactoryItem['degraded'] }): ReactNode {
  if (degraded.length === 0) return null;
  return (
    <Panel className="p-4">
      <ul
        aria-label="What could not be read"
        className="flex flex-col gap-1 text-console-13 text-text-tertiary"
      >
        {degraded.map(report => (
          <li key={JSON.stringify(report)}>{degradedWords(report)}</li>
        ))}
      </ul>
    </Panel>
  );
}

function degradedWords(report: FactoryItem['degraded'][number]): string {
  switch (report.reason) {
    case 'ruling_unreadable':
      return `A ruling (${report.rulingId}) could not be read.`;
    case 'link_unreadable':
      return `A link (${report.linkId}) could not be read.`;
    case 'merge_unreadable':
      return 'The merge record of this item could not be read.';
    case 'landing_unresolved':
      return report.message;
    default:
      return report.runId === undefined
        ? 'Part of this item could not be read.'
        : `Run ${report.runId} could not be read.`;
  }
}
