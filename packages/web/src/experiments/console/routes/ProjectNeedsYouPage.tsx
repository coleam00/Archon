/**
 * A project's open asks on a tab of their own. One row an item with asks, newest first: its key
 * and title as the board prints them, the stage it is at, how long it has waited, the question
 * and the suggested option. The suggestion is muted, never green: a green line read as if the
 * ask were already answered. A row opens to Archon's own ask section (`ItemAsksSection`), where
 * the ask is answered, so there is no second ask form. The install-wide Needs you page is
 * separate.
 *
 * `?item=<key>` (repeatable or comma-separated; a raw key or an issue number) shows only those
 * items' asks, each value with a chip that links back without it. A filtered item with one ask
 * opens that ask directly.
 */
import { useState, type ReactElement } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import {
  askGroupKey,
  itemAsksAnchor,
  ItemAsksSection,
  useItemAsks,
  type ItemAsks,
} from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { useForgeTitles } from '../factory/FactoryCards';
import { humaniseId, itemTitle } from '../factory/lib/item-card';
import { useBoardItems } from '../factory/useBoardItems';
import { relativeTime } from '../lib/format';
import { displayItemKey, issueNumber } from '../lib/item-key';
import type { ItemAsk } from '../primitives/run';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import type { ItemRead } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

interface Row {
  key: string;
  asks: ItemAsk[];
  newest: ItemAsk;
}

/** The issue titles the board reads, as its hook returns them. */
type ForgeTitles = ReturnType<typeof useForgeTitles>;

/** One row an item, the item with the newest ask first. */
function rowsOf(asks: readonly ItemAsk[]): Row[] {
  const rows = new Map<string, Row>();
  for (const ask of asks) {
    const key = askGroupKey(ask);
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { key, asks: [ask], newest: ask });
    else {
      row.asks.push(ask);
      if (pausedMs(ask) > pausedMs(row.newest)) row.newest = ask;
    }
  }
  return [...rows.values()].sort((a, b) => pausedMs(b.newest) - pausedMs(a.newest));
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

/**
 * Whether an ask is of the item `wanted` names: its raw key, or the same issue number (`198`
 * and `issue-198` name one issue). Exact: a parent's number does not take in its split members.
 * An ask with no item is of none.
 */
export function matchesItemFilter(ask: Pick<ItemAsk, 'item'>, wanted: string): boolean {
  const key = ask.item?.key;
  if (key === undefined) return false;
  if (key === wanted) return true;
  const number = issueNumber(wanted);
  return number !== null && number === issueNumber(key);
}

/** The item's key and title as the board prints them; without its board read, the ask's own. */
function keyAndTitle(
  item: ItemAsk['item'],
  read: ItemRead | undefined,
  titles: ForgeTitles
): { keyText: string; title: string } {
  if (item === undefined) return { keyText: 'Item', title: '' };
  if (read === undefined) return { keyText: displayItemKey(item.key), title: item.title ?? '' };
  const { title, titleIsKey, keyText } = itemTitle(read, titles);
  return { keyText, title: titleIsKey ? '' : title };
}

/** Where the page goes with `value` dropped from the filter, every other param kept. */
function withoutFilter(pathname: string, params: URLSearchParams, value: string): string {
  const rest = itemFilter(params).filter(other => other !== value);
  const next = new URLSearchParams(params);
  next.delete('item');
  if (rest.length > 0) next.set('item', rest.join(','));
  const search = next.toString();
  return search === '' ? pathname : `${pathname}?${search}`;
}

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
  const { item } = row.newest;
  const { keyText, title } = keyAndTitle(item, read, titles);
  const recommendation = row.newest.recommendation;
  const recommended = row.newest.options.find(option => option.id === recommendation?.option);
  const stage = stageOf(read);
  const total = row.asks.length;
  return (
    <li
      data-needs-row={row.key}
      data-item-key={item?.key}
      id={itemAsksAnchor(row.key)}
      className="flex flex-col gap-2"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(value => !value);
        }}
        className="flex w-full flex-col gap-1 rounded border border-warning/40 bg-surface px-4 py-3 text-left hover:bg-surface-hover"
      >
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
          {total > 1 ? (
            <span className="text-console-11 text-warning">{String(total)} open asks</span>
          ) : null}
        </span>
        <span className="text-sm text-text-primary">{row.newest.message}</span>
        {recommended === undefined ? null : (
          <span data-suggested={recommended.id} className="text-console-12 text-text-secondary">
            Suggested: {recommended.label ?? humaniseId(recommended.id)}
          </span>
        )}
      </button>
      {open ? (
        <ItemAsksSection
          {...itemAsks}
          asks={row.asks}
          answered={itemAsks.answered.filter(record => askGroupKey(record.ask) === row.key)}
          showProject={false}
        />
      ) : null}
    </li>
  );
}

/** One chip a filtered value, each a link to the page without that value. */
function FilterChips({
  wanted,
  chipText,
}: {
  wanted: readonly string[];
  chipText: (value: string) => string;
}): ReactElement | null {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  if (wanted.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {wanted.map(value => {
        const text = chipText(value);
        return (
          <Link
            key={value}
            data-item-filter={value}
            aria-label={`Clear the filter for ${text}`}
            to={withoutFilter(pathname, params, value)}
            className="rounded-full border border-border px-3 py-1 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            Item {text} ×
          </Link>
        );
      })}
    </div>
  );
}

function emptyTitle(wanted: readonly string[], chipText: (value: string) => string): string {
  return wanted.length === 0
    ? 'Nothing needs you in this project.'
    : `Nothing needs you on ${wanted.map(chipText).join(', ')}.`;
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
  const titles = useForgeTitles(projectId === '' ? null : projectId, boardReads);
  const readOf = (ask: ItemAsk): ItemRead | undefined =>
    ask.item === undefined ? undefined : reads.get(ask.item.id);

  const wanted = itemFilter(params);
  const shown = (ask: ItemAsk): boolean =>
    wanted.length === 0 || wanted.some(value => matchesItemFilter(ask, value));
  const asks = itemAsks.asks.filter(shown);
  const rows = rowsOf(asks);
  // Rows whose asks were all answered here stay until dismissed, as they do elsewhere.
  const answeredOnly = itemAsks.answered.filter(
    record =>
      shown(record.ask) && !itemAsks.asks.some(ask => askGroupKey(ask) === askGroupKey(record.ask))
  );
  const linked = location.hash.replace(/^#/, '');
  // A filtered link to an item with one ask is a link to that ask, so it opens.
  const openOnly = wanted.length > 0 && rows.length === 1 && rows[0]?.asks.length === 1;
  /** A filtered value as its row's key prints, else as a key reads. */
  const chipText = (value: string): string => {
    const ask = asks.find(candidate => matchesItemFilter(candidate, value));
    return ask === undefined
      ? displayItemKey(value)
      : keyAndTitle(ask.item, readOf(ask), titles).keyText;
  };
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4 md:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-text-primary">
            {project?.name ?? 'Project'}
          </h1>
          <p role="status" className="text-xs text-text-tertiary">
            {error !== undefined
              ? error.message
              : attention === undefined
                ? 'Reading asks…'
                : `${String(asks.length)} open ${asks.length === 1 ? 'ask' : 'asks'}`}
          </p>
        </div>
        <ProjectViewTabs projectId={projectId} active="needs-you" />
      </header>
      <div
        data-needs-you
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-8 pt-4 md:px-6"
      >
        <FilterChips wanted={wanted} chipText={chipText} />
        {rows.length === 0 && answeredOnly.length === 0 && error === undefined ? (
          <EmptyState title={emptyTitle(wanted, chipText)} />
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
        {answeredOnly.length > 0 ? (
          <ItemAsksSection {...itemAsks} asks={[]} answered={answeredOnly} showProject={false} />
        ) : null}
      </div>
    </section>
  );
}
