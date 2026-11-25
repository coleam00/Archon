/**
 * A project's open asks on a tab of their own. One row an item with asks, newest first: its key
 * and title, the stage it is at, how long it has waited, the question and the recommended
 * option. A row opens to Archon's own ask section (`ItemAsksSection`), where the ask is
 * answered, so there is no second ask form. The install-wide Needs you page is separate.
 */
import { useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import {
  askGroupKey,
  itemAsksAnchor,
  ItemAsksSection,
  useItemAsks,
  type ItemAsks,
} from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { useBoardItems } from '../factory/useBoardItems';
import { relativeTime } from '../lib/format';
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

function AskRow({
  row,
  read,
  itemAsks,
  startOpen,
}: {
  row: Row;
  read: ItemRead | undefined;
  itemAsks: ItemAsks;
  startOpen: boolean;
}): ReactElement {
  const [open, setOpen] = useState(startOpen);
  const { item } = row.newest;
  const recommendation = row.newest.recommendation;
  const recommended = row.newest.options.find(option => option.id === recommendation?.option);
  const stage = stageOf(read);
  const total = row.asks.length;
  return (
    <li data-needs-row={row.key} id={itemAsksAnchor(row.key)} className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(value => !value);
        }}
        className="flex w-full flex-col gap-1 rounded border border-warning/40 bg-surface px-4 py-3 text-left hover:bg-surface-hover"
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm text-text-primary">{item?.key ?? 'Item'}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
            {item?.title ?? ''}
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
          <span data-recommended={recommended.id} className="text-console-12 text-success">
            Recommended: {recommended.label ?? recommended.id}
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

export function ProjectNeedsYouPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const project = projects?.find(candidate => candidate.id === projectId);
  const { data: attention, error } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const itemAsks = useItemAsks(attention, projectId);
  const every = useBoardItems(projectId);
  const reads = new Map((every.data ?? []).map(read => [read.item.id, read]));
  const rows = rowsOf(itemAsks.asks);
  // Rows whose asks were all answered here stay until dismissed, as they do elsewhere.
  const answeredOnly = itemAsks.answered.filter(
    record => !itemAsks.asks.some(ask => askGroupKey(ask) === askGroupKey(record.ask))
  );
  const linked = window.location.hash.replace(/^#/, '');
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
                : `${String(itemAsks.asks.length)} open ${itemAsks.asks.length === 1 ? 'ask' : 'asks'}`}
          </p>
        </div>
        <ProjectViewTabs projectId={projectId} active="needs-you" />
      </header>
      <div
        data-needs-you
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-8 pt-4 md:px-6"
      >
        {rows.length === 0 && answeredOnly.length === 0 && error === undefined ? (
          <EmptyState title="Nothing needs you in this project." />
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map(row => (
              <AskRow
                key={row.key}
                row={row}
                read={row.newest.item === undefined ? undefined : reads.get(row.newest.item.id)}
                itemAsks={itemAsks}
                startOpen={linked === itemAsksAnchor(row.key)}
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
