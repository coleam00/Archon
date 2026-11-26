/**
 * A project's open asks on a tab of their own. One row an item with asks, newest first: its key
 * and title as the board prints them, the stage it is at, how long it has waited, the question
 * and the suggested option. A row is a disclosure: its chevron header opens Archon's own ask
 * section (`ItemAsksSection`) as the row's child, inside the row's frame and indented under it,
 * so the ask belongs visibly to the row that opened it and there is no second ask form. A row
 * whose asks were all answered here stays where it was, open as it was, showing Archon's answered
 * line until it is dismissed; answered records last this session only, so after a reload the
 * attention list alone decides the rows (#240). The
 * console's accent marks three things only (owner, 11/26): the suggested answer, the active
 * filter and the open row's marker; never green, which read as if the ask were already answered.
 * The install-wide Needs you page is separate.
 *
 * `?item=<key>` (repeatable or comma-separated; a raw key or an issue number) shows only those
 * items' asks under a filter bar naming each item, with its own remove link when there are
 * several, and "Show all". A filtered item with one ask opens that ask directly. While the asks
 * are still being read the body shows skeleton rows and never says nothing needs you (#222).
 */
import { ChevronRight, X } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import {
  askGroupKey,
  itemAsksAnchor,
  ItemAsksSection,
  useItemAsks,
  type AnsweredAsk,
  type ItemAsks,
} from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { useForgeTitles } from '../factory/FactoryCards';
import { humaniseId, itemTitle } from '../factory/lib/item-card';
import { useBoardItems } from '../factory/useBoardItems';
import { relativeTime } from '../lib/format';
import { displayItemKey, matchesItemFilter, openAsksOf } from '../lib/item-key';
import type { ItemAsk } from '../primitives/run';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import type { ItemRead } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

interface Row {
  key: string;
  /** Open asks not answered here this session. */
  asks: ItemAsk[];
  /** The item's asks answered here this session. */
  answered: AnsweredAsk[];
  /** What the header describes: the newest open ask, else the newest answered one. */
  newest: ItemAsk;
  /**
   * The newest wait across open and answered asks, so a row sorts by the same age once answered.
   * Rows of equal age have no fixed order between them.
   */
  sortMs: number;
}

/** The issue titles the board reads, as its hook returns them. */
type ForgeTitles = ReturnType<typeof useForgeTitles>;

/** A filtered value as the filter bar names it; `none` once the read found nothing open on it. */
interface FilterEntry {
  value: string;
  keyText: string;
  title: string;
  none: boolean;
}

/**
 * One row an item, open or answered here, the item with the newest ask first. An answered ask
 * stays in the list until its refetch lands; it counts as answered, never as open.
 */
function rowsOf(open: readonly ItemAsk[], answered: readonly AnsweredAsk[]): Row[] {
  const rows = new Map<string, Row>();
  const rowOf = (ask: ItemAsk): Row => {
    const key = askGroupKey(ask);
    let row = rows.get(key);
    if (row === undefined) {
      row = { key, asks: [], answered: [], newest: ask, sortMs: 0 };
      rows.set(key, row);
    }
    return row;
  };
  const answeredRefs = new Set(answered.map(record => record.ask.ref));
  for (const ask of open) if (!answeredRefs.has(ask.ref)) rowOf(ask).asks.push(ask);
  for (const record of answered) rowOf(record.ask).answered.push(record);
  for (const row of rows.values()) {
    const every = [...row.asks, ...row.answered.map(record => record.ask)];
    row.sortMs = Math.max(...every.map(pausedMs));
    row.newest =
      newestOf(row.asks) ?? newestOf(row.answered.map(record => record.ask)) ?? row.newest;
  }
  return [...rows.values()].sort((a, b) => b.sortMs - a.sortMs);
}

function newestOf(asks: readonly ItemAsk[]): ItemAsk | undefined {
  return asks.reduce<ItemAsk | undefined>(
    (newest, ask) => (newest === undefined || pausedMs(ask) > pausedMs(newest) ? ask : newest),
    undefined
  );
}

function pausedMs(ask: ItemAsk): number {
  return ask.pausedAt === null ? 0 : Date.parse(ask.pausedAt);
}

/** The workflow of the item's run that stands, else its latest: the stage it sits at. */
function stageOf(read: ItemRead | undefined): string | undefined {
  if (read === undefined) return undefined;
  const run = read.runs.find(candidate => candidate.id === read.standing.runId) ?? read.runs.at(-1);
  return run?.workflow;
}

/** The `item` filter's values: every `item` param, split on commas, trimmed, each once. */
export function itemFilter(params: URLSearchParams): string[] {
  const values = params
    .getAll('item')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value !== '');
  return [...new Set(values)];
}

/** The item's key and title as the board prints them; without its board read, the ask's own. */
function keyAndTitle(
  item: ItemAsk['item'],
  read: ItemRead | undefined,
  titles: ForgeTitles
): { keyText: string; title: string } {
  if (item === undefined) return { keyText: 'Item', title: '' };
  if (read === undefined) return { keyText: displayItemKey(item.key), title: item.title ?? '' };
  return readKeyAndTitle(read, titles);
}

/** The key and title the board's read prints; no title when it would only repeat the key. */
function readKeyAndTitle(read: ItemRead, titles: ForgeTitles): { keyText: string; title: string } {
  const { title, titleIsKey, keyText } = itemTitle(read, titles);
  return { keyText, title: titleIsKey ? '' : title };
}

/** Where the page goes with the filter set to `keep` (none: no filter), every other param kept. */
function withFilter(pathname: string, params: URLSearchParams, keep: readonly string[]): string {
  const next = new URLSearchParams(params);
  next.delete('item');
  if (keep.length > 0) next.set('item', keep.join(','));
  const search = next.toString();
  return search === '' ? pathname : `${pathname}?${search}`;
}

function AskRowHeader({
  row,
  read,
  titles,
  open,
  childId,
  onToggle,
}: {
  row: Row;
  read: ItemRead | undefined;
  titles: ForgeTitles;
  open: boolean;
  childId: string;
  onToggle: () => void;
}): ReactElement {
  const { keyText, title } = keyAndTitle(row.newest.item, read, titles);
  const recommendation = row.newest.recommendation;
  const recommended = row.newest.options.find(option => option.id === recommendation?.option);
  const stage = stageOf(read);
  const openAsks = row.asks.length;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={childId}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left hover:bg-surface-hover"
    >
      <ChevronRight
        aria-hidden
        size={16}
        className={`mt-0.5 shrink-0 text-text-tertiary motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm text-text-primary">{keyText}</span>
          <span data-item-title className="min-w-0 flex-1 truncate text-sm text-text-secondary">
            {title}
          </span>
          {stage === undefined ? null : (
            <span data-stage className="text-console-11 text-text-tertiary">
              {stage}
            </span>
          )}
          {row.newest.pausedAt === null ? null : (
            <span data-age className="text-console-11 text-text-tertiary">
              {relativeTime(row.newest.pausedAt)}
            </span>
          )}
          {openAsks > 1 ? (
            <span className="text-console-11 text-warning">{String(openAsks)} open asks</span>
          ) : null}
        </span>
        <span className="text-sm text-text-primary">{row.newest.message}</span>
        {/* A suggestion on a row with nothing open would read as still pending. */}
        {recommended === undefined || openAsks === 0 ? null : (
          <span data-suggested={recommended.id} className="text-console-12 text-accent-bright">
            Suggested: {recommended.label ?? humaniseId(recommended.id)}
          </span>
        )}
      </span>
    </button>
  );
}

/** A row and, while open, its child: Archon's ask section inside the row's own frame. */
function AskRow({
  row,
  read,
  titles,
  itemAsks,
  startOpen,
}: {
  row: Row;
  read: ItemRead | undefined;
  titles: ForgeTitles;
  itemAsks: ItemAsks;
  startOpen: boolean;
}): ReactElement {
  const [open, setOpen] = useState(startOpen);
  const anchor = itemAsksAnchor(row.key);
  const childId = `${anchor}-child`;
  return (
    <li
      data-needs-row={row.key}
      data-item-key={row.newest.item?.key}
      // The opened ask section carries the anchor itself; one id on the page.
      id={open ? undefined : anchor}
      className="relative overflow-hidden rounded-console-12 border border-border bg-surface"
    >
      {/* The open row's marker is a filled bar, not a border colour: the console theme sets
          every border's colour (`theme.css`, `.console-root *`) over Tailwind's utilities. */}
      {open ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent-bright" />
      ) : null}
      <AskRowHeader
        row={row}
        read={read}
        titles={titles}
        open={open}
        childId={childId}
        onToggle={() => {
          setOpen(value => !value);
        }}
      />
      {open ? (
        <div
          id={childId}
          data-needs-child
          className="border-t border-border bg-surface-inset py-3 pl-11 pr-3"
        >
          <ItemAsksSection
            {...itemAsks}
            asks={row.asks}
            answered={row.answered}
            showProject={false}
          />
        </div>
      ) : null}
    </li>
  );
}

/** The active `?item=` filter: what it shows, a remove link per item when several, "Show all". */
function FilterBar({ entries }: { entries: readonly FilterEntry[] }): ReactElement | null {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  if (entries.length === 0) return null;
  const several = entries.length > 1;
  return (
    <div
      data-filter-bar
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-console-12 border border-border bg-accent-bright/10 px-4 py-3"
    >
      <span className="text-sm text-text-secondary">Showing asks for</span>
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
        {entries.map(entry => (
          <li
            key={entry.value}
            data-item-filter={entry.value}
            className="flex min-w-0 items-center gap-2"
          >
            <span className="font-mono text-sm text-text-primary">{entry.keyText}</span>
            {entry.title === '' ? null : (
              <span className="min-w-0 truncate text-sm text-text-secondary">{entry.title}</span>
            )}
            {entry.none ? (
              <span className="text-console-12 text-text-tertiary">nothing open</span>
            ) : null}
            {several ? (
              <Link
                aria-label={`Remove the filter for ${entry.keyText}`}
                to={withFilter(
                  pathname,
                  params,
                  entries.map(other => other.value).filter(value => value !== entry.value)
                )}
                className="rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
              >
                <X aria-hidden size={14} />
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      <Link
        data-filter-clear
        to={withFilter(pathname, params, [])}
        className="shrink-0 rounded-console-12 border border-border bg-surface px-3 py-1 text-console-12 font-medium text-text-primary hover:bg-accent-bright/20"
      >
        Show all
      </Link>
    </div>
  );
}

/** The final layout's shape while the asks are read: a row block holding two text bars. */
function LoadingRows(): ReactElement {
  return (
    <ul data-needs-loading aria-hidden className="flex flex-col gap-3">
      {[0, 1, 2].map(index => (
        <li
          key={index}
          className="flex flex-col gap-2 rounded-console-12 bg-surface-elevated px-4 py-4 motion-safe:animate-pulse"
        >
          <span className="h-3 w-3/5 rounded bg-surface-hover" />
          <span className="h-3 w-2/5 rounded bg-surface-hover" />
        </li>
      ))}
    </ul>
  );
}

/**
 * A filtered value as the bar names it: from its ask, else from the board's read (which loads
 * apart from the asks, so the bar names the item while they are still read), else as the key
 * reads. `read` says the asks have been read, so a value with none has nothing open.
 */
function filterEntry(
  value: string,
  from: {
    asks: readonly ItemAsk[];
    boardReads: readonly ItemRead[];
    readOf: (ask: ItemAsk) => ItemRead | undefined;
    titles: ForgeTitles;
    read: boolean;
  }
): FilterEntry {
  const ask = from.asks.find(candidate => matchesItemFilter(candidate, value));
  const boardRead = from.boardReads.find(candidate => matchesItemFilter(candidate, value));
  const named =
    ask !== undefined
      ? keyAndTitle(ask.item, from.readOf(ask), from.titles)
      : boardRead !== undefined
        ? readKeyAndTitle(boardRead, from.titles)
        : { keyText: displayItemKey(value), title: '' };
  return { value, ...named, none: from.read && ask === undefined };
}

/** The header's status: the read's error, else that the asks are being read, else their count. */
function statusLine(error: Error | undefined, read: boolean, count: number): string {
  if (error !== undefined) return error.message;
  if (!read) return 'Reading asks…';
  return `${String(count)} open ${count === 1 ? 'ask' : 'asks'}`;
}

function emptyTitle(entries: readonly FilterEntry[]): string {
  return entries.length === 0
    ? 'Nothing needs you in this project.'
    : `Nothing needs you on ${entries.map(entry => entry.keyText).join(', ')}.`;
}

export function ProjectNeedsYouPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const location = useLocation();
  const [params] = useSearchParams();
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const project = projects?.find(candidate => candidate.id === projectId);
  const { data: attention, error } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const itemAsks = useItemAsks(attention, projectId);
  const every = useBoardItems(projectId);
  const boardReads = every.data ?? [];
  const reads = new Map(boardReads.map(read => [read.item.id, read]));
  const readOf = (ask: ItemAsk): ItemRead | undefined =>
    ask.item === undefined ? undefined : reads.get(ask.item.id);
  const wanted = itemFilter(params);
  // Only the items with open asks and the filtered ones print a title here; asking the forge for
  // every board item costs a lookup per titleless issue on a cold server.
  const titles = useForgeTitles(projectId === '' ? null : projectId, [
    ...new Set([
      ...itemAsks.asks.flatMap(ask => readOf(ask) ?? []),
      ...boardReads.filter(read => wanted.some(value => matchesItemFilter(read, value))),
    ]),
  ]);
  const shown = (ask: ItemAsk): boolean =>
    wanted.length === 0 || wanted.some(value => matchesItemFilter(ask, value));
  const asks = itemAsks.asks.filter(shown);
  const rows = rowsOf(
    asks,
    itemAsks.answered.filter(record => shown(record.ask))
  );
  // Counted as a board card counts its "Needs you · N", so the link's N is this line's.
  const open = openAsksOf(itemAsks.asks, itemAsks.answered, wanted).length;
  const linked = location.hash.replace(/^#/, '');
  // A filtered link to an item with one ask is a link to that ask, so it opens.
  const openOnly = wanted.length > 0 && rows.length === 1 && rows[0]?.asks.length === 1;
  const entries = wanted.map(value =>
    filterEntry(value, { asks, boardReads, readOf, titles, read: attention !== undefined })
  );
  const reading = attention === undefined && error === undefined;
  const empty = rows.length === 0 && error === undefined;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4 md:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-text-primary">
            {project?.name ?? 'Project'}
          </h1>
          <p role="status" className="text-xs text-text-tertiary">
            {statusLine(error, attention !== undefined, open)}
          </p>
        </div>
        <ProjectViewTabs projectId={projectId} active="needs-you" />
      </header>
      <div
        data-needs-you
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-8 pt-4 md:px-6"
      >
        <FilterBar entries={entries} />
        {reading ? (
          <LoadingRows />
        ) : empty ? (
          <EmptyState title={emptyTitle(entries)} />
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map(row => (
              <AskRow
                key={row.key}
                row={row}
                read={readOf(row.newest)}
                titles={titles}
                itemAsks={itemAsks}
                startOpen={linked === itemAsksAnchor(row.key) || openOnly}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
