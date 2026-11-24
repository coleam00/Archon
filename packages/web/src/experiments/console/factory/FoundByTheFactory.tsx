import type { ReactElement, ReactNode } from 'react';
import { displayItemKey } from './lib/item-key';
import type { ItemName } from '../lib/ask-naming';
import { Link } from 'react-router';
import { EmptyNote } from '../components/EmptyNote';
import { SkeletonFigure, SkeletonGroup, SkeletonLine } from '../components/Skeleton';
import { formatDateTime } from '../lib/format';
import { errorDetail } from '../lib/http';
import type { FactoryDiscoveries } from '../skills/factory';
import { itemPath } from './lib/board';
import { readFailed } from './lib/deadline';
import { ShadowBadge } from './ShadowBadge';
import {
  type FactoryFinding,
  FOUND_BY_THE_FACTORY,
  foundChips,
  kindLabel,
  openFindings,
} from './lib/discoveries';
import { FactoryLoading } from './FactoryLoading';
import { StaleRead } from './StaleRead';
import { useFactoryDiscoveries } from './useFactoryDiscoveries';

const HEADING_ID = `${FOUND_BY_THE_FACTORY}-heading`;

/** The shadow accent (Visual standard, rule 10): the drains did nothing. */
function ShadowAccent(): ReactElement {
  return (
    <span aria-hidden className="absolute inset-x-0 top-0 h-0.75 bg-[color:var(--node-opaque)]" />
  );
}

/**
 * "Found by the factory" as one line under the board: its name, the shadow badge, and "14 the
 * factory would file", or what its read says when there is nothing to show yet. The board's one
 * toggle, beside it, opens the panel below the board. Mount it only when the view declares
 * `discoveries`.
 */
export function FoundByTheFactoryLine({ projectId }: { projectId: string }): ReactElement {
  const read = useFactoryDiscoveries(projectId);
  const { data } = read;
  const failed = data === undefined ? readFailed(read.error) : undefined;
  const findings = data === undefined ? [] : openFindings(data);
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="relative flex flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden rounded-console-12 border border-border bg-surface px-4 py-2"
    >
      <ShadowAccent />
      <h2 id={HEADING_ID} className="text-console-15 font-semibold text-text-primary">
        Found by the factory
      </h2>
      {data?.shadow === true ? <ShadowBadge /> : null}
      {data === undefined ? (
        failed === undefined ? (
          <FoundSkeleton read={read} />
        ) : (
          <p role="alert" className="text-console-13 text-error">
            What the factory found could not be read: {errorDetail(failed)}
          </p>
        )
      ) : findings.length === 0 ? (
        <span className="text-console-13 text-text-secondary">
          {data.shadow
            ? 'Nothing the factory would file now'
            : 'Nothing filed that is not on the board'}
        </span>
      ) : (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span
            data-found-count
            className="text-console-17 font-semibold tabular-nums text-text-primary"
          >
            {findings.length}
          </span>
          <span className="text-console-13 text-text-secondary">
            {data.shadow ? 'the factory would file' : 'filed, not on the board yet'}
          </span>
        </span>
      )}
    </section>
  );
}

/**
 * The board's "Found by the factory" panel, opened below the board by its one toggle: what the
 * discoveries drains decided to file from what agents noticed outside their scope, that no item
 * on the project carries yet, each finding listed. Read-only. While the drains are a shadow
 * (the view says so) it reads as one: they decide what they would file and file nothing. Its
 * heading is on the line ({@link FoundByTheFactoryLine}), as are the skeleton and a failed
 * read's error, so it draws nothing until the read has answered.
 */
export function FoundByTheFactory({
  projectId,
  names,
}: {
  projectId: string;
  /** The board's items by key, so a finding's item reads as the board reads it (a split member under its order). */
  names: ReadonlyMap<string, ItemName>;
}): ReactElement | null {
  const read = useFactoryDiscoveries(projectId);
  const { data } = read;
  if (data === undefined) return null;
  return (
    <section
      id={FOUND_BY_THE_FACTORY}
      aria-labelledby={HEADING_ID}
      className="relative flex flex-col gap-2 overflow-hidden rounded-console-12 border border-border bg-surface p-4"
    >
      <ShadowAccent />
      {data.shadow ? (
        <p className="text-console-13 text-text-tertiary">
          Would file what agents noticed outside their work: the factory decides what it would file,
          and files nothing yet.
        </p>
      ) : null}
      <StaleRead error={read.error} />
      <FoundPanel projectId={projectId} names={names} read={data} />
    </section>
  );
}

function FoundSkeleton({ read }: { read: ReturnType<typeof useFactoryDiscoveries> }): ReactElement {
  return (
    <FactoryLoading read={read}>
      <SkeletonGroup label="Reading what the factory found" className="flex flex-col gap-2">
        <SkeletonFigure />
        <SkeletonLine width="short" />
      </SkeletonGroup>
    </FactoryLoading>
  );
}

/** The count, the chips, and the findings listed. */
function FoundPanel({
  projectId,
  names,
  read,
}: {
  projectId: string;
  names: ReadonlyMap<string, ItemName>;
  read: FactoryDiscoveries;
}): ReactElement {
  const findings = openFindings(read);
  const covered = read.findings.length - findings.length;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-baseline gap-2">
        <span
          data-found-count
          className="text-console-22 font-semibold tabular-nums text-text-primary"
        >
          {findings.length}
        </span>
        <span className="text-console-13 text-text-secondary">
          {read.shadow ? 'the factory would file' : 'filed'}, not on the board yet
        </span>
      </p>
      <ul aria-label="What the drains decided" className="flex flex-wrap gap-2">
        {foundChips(read).map(chip => (
          <li
            key={chip.label}
            className="rounded bg-surface-inset px-1.5 py-0.5 text-console-12 text-[color:var(--node-opaque)]"
          >
            {chip.label} {chip.count}
          </li>
        ))}
      </ul>
      <MetaLines covered={covered} unreadable={read.unreadable} />
      {findings.length === 0 ? (
        <NothingFound shadow={read.shadow} />
      ) : (
        <ul id={`${FOUND_BY_THE_FACTORY}-list`} className="flex flex-col gap-3">
          {findings.map(finding => (
            <FindingRow
              key={`${finding.runId}:${finding.title}`}
              projectId={projectId}
              finding={finding}
              partOf={names.get(finding.from.key)?.partOf ?? null}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MetaLines({ covered, unreadable }: { covered: number; unreadable: number }): ReactNode {
  if (covered === 0 && unreadable === 0) return null;
  return (
    <p className="text-console-13 text-text-tertiary">
      {[
        covered > 0 ? `${covered.toString()} already on the board` : null,
        unreadable > 0
          ? `${unreadable.toString()} ${unreadable === 1 ? 'drain' : 'drains'} could not be read`
          : null,
      ]
        .filter(line => line !== null)
        .join(' · ')}
    </p>
  );
}

function NothingFound({ shadow }: { shadow: boolean }): ReactElement {
  return (
    <EmptyNote
      className="flex items-center gap-2"
      sentence={
        shadow
          ? 'Nothing the factory would file now. What agents notice after a delivery shows here.'
          : 'Nothing filed that is not on the board. What agents notice after a delivery shows here.'
      }
    />
  );
}

/** One finding: its kind, title, the item whose drain decided it, and how it was checked on hover. */
function FindingRow({
  projectId,
  finding,
  partOf,
}: {
  projectId: string;
  finding: FactoryFinding;
  /** The work order the finding's item is in, which its key reads under. */
  partOf: string | null;
}): ReactElement {
  const kind = kindLabel(finding.kind);
  return (
    <li title={finding.verified ?? undefined} className="flex flex-col gap-2">
      {kind === null ? null : (
        <span className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
          {kind}
        </span>
      )}
      <span className="text-console-15 font-semibold text-text-primary">{finding.title}</span>
      <span className="text-console-13 text-text-secondary">
        from{' '}
        <Link
          to={itemPath(projectId, finding.from.key)}
          className="font-mono text-text-primary hover:underline"
        >
          {displayItemKey(finding.from.key, partOf)}
        </Link>
        {finding.from.title === null ? '' : ` · ${finding.from.title}`} ·{' '}
        {formatDateTime(finding.decidedAt)}
      </span>
      {finding.verified === null ? null : (
        <span className="sr-only">Verified: {finding.verified}</span>
      )}
    </li>
  );
}
