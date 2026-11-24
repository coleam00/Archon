import { CheckCheck } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { Panel, SectionHeading } from '../../factory/document';
import type { AnsweredRow } from '../../factory/lib/answered';
import { relativeTime } from '../../lib/format';
import { errorDetail } from '../../lib/http';
import { SkeletonGroup, SkeletonInnerLine } from '../Skeleton';
import { SubjectName } from '../ask-card/AskCard';

type Restart = NonNullable<AnsweredRow['restart']>;

/** Rule 5's state colours, as text: what a restarted run is doing now. */
const STATUS: Record<Restart['status'], { words: string; color: string }> = {
  pending: { words: 'waiting to start', color: 'text-[color:var(--running)]' },
  running: { words: 'running', color: 'text-[color:var(--running)]' },
  paused: { words: 'paused', color: 'text-warning' },
  completed: { words: 'done', color: 'text-success' },
  failed: { words: 'failed', color: 'text-error' },
  cancelled: { words: 'cancelled', color: 'text-text-tertiary' },
};

/**
 * Answered lately (owner change 9), the page's aside: one quiet panel of compact rows, one per
 * answer, newest first. Each row names the item, the question, the option chosen as a pill,
 * who answered and when, and what settling its set started, in that run's state colour.
 * Unread, it shows skeleton rows; a failed read says so inside the panel. It never goes away,
 * so the page keeps its shape.
 */
export function AnsweredLately({
  projectId,
  rows,
  failed,
  href,
  className = '',
}: {
  projectId: string;
  /** Undefined while the history is unread or its read failed. */
  rows: readonly AnsweredRow[] | undefined;
  failed: Error | undefined;
  /** The item's page, or its run without a view. */
  href: (row: AnsweredRow) => string | undefined;
  /** Its place in the page's grid. */
  className?: string;
}): ReactElement {
  return (
    <section
      data-doc-section=""
      aria-label="Answered lately"
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      <SectionHeading
        icon={CheckCheck}
        eyebrow="Answered lately"
        title="What was decided"
        tone="var(--text-tertiary)"
        {...(rows === undefined ? {} : { count: rows.length })}
      />
      <Panel className="flex flex-col px-4 py-1">
        <AnsweredBody projectId={projectId} rows={rows} failed={failed} href={href} />
      </Panel>
    </section>
  );
}

function AnsweredBody({
  projectId,
  rows,
  failed,
  href,
}: {
  projectId: string;
  rows: readonly AnsweredRow[] | undefined;
  failed: Error | undefined;
  href: (row: AnsweredRow) => string | undefined;
}): ReactElement {
  if (rows === undefined && failed !== undefined)
    return (
      <p role="alert" className="py-3 text-console-13 text-error [overflow-wrap:anywhere]">
        What was answered lately could not be loaded: {errorDetail(failed)}
      </p>
    );
  if (rows === undefined)
    return (
      // Inner lines: a panel is the skeleton block's own fill, so a plain bar would not show.
      <SkeletonGroup
        label="Loading what was answered lately"
        className="flex flex-col gap-4 py-3 motion-safe:animate-pulse"
      >
        {[0, 1, 2].map(index => (
          <span key={index} className="flex flex-col gap-2">
            <SkeletonInnerLine />
            <SkeletonInnerLine width="short" />
          </span>
        ))}
      </SkeletonGroup>
    );
  if (rows.length === 0)
    return (
      <p className="py-3 text-console-14 text-text-secondary">
        Answers given here, from the CLI or by an agent, appear here.
      </p>
    );
  return (
    <ul className="flex flex-col">
      {rows.map((row, index) => (
        <li
          key={`${row.itemKey}:${row.runId}:${index.toString()}`}
          className={`flex min-w-0 flex-col gap-1 py-3 ${index === 0 ? '' : 'border-t border-border'}`}
        >
          <AnsweredLine projectId={projectId} row={row} href={href(row)} />
        </li>
      ))}
    </ul>
  );
}

function AnsweredLine({
  projectId,
  row,
  href,
}: {
  projectId: string;
  row: AnsweredRow;
  href: string | undefined;
}): ReactElement {
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-3 text-console-13 text-text-tertiary">
        <SubjectName
          subject={{
            key: row.itemKey,
            partOf: row.partOf,
            ...(row.title === null ? {} : { title: row.title }),
            ...(href === undefined ? {} : { href }),
          }}
        />
        <span className="ml-auto shrink-0 whitespace-nowrap">{relativeTime(row.at)}</span>
      </div>
      <p title={row.question} className="truncate text-console-13 text-text-secondary">
        {row.question}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-console-12">
        {row.withdrawn ? (
          <span className="text-text-tertiary line-through">Withdrawn</span>
        ) : (
          <span
            data-answer-pill=""
            className="rounded-full bg-surface-inset px-2 py-0.5 font-medium text-text-primary [overflow-wrap:anywhere]"
          >
            {row.answer}
          </span>
        )}
        {row.by === null ? null : <span className="text-text-tertiary">by {row.by}</span>}
        <Started projectId={projectId} row={row} />
      </div>
    </>
  );
}

/**
 * What settling the answer's set started, in that run's state colour, with its state in words.
 * An option the view words (`starts`) reads that sentence in place of the stage, linked to the
 * run only when settling started one: with several, which one is this answer's is not known.
 */
function Started({ projectId, row }: { projectId: string; row: AnsweredRow }): ReactNode {
  const { restart, starts } = row;
  if (starts !== null && (restart === null || row.restarts !== 1))
    return (
      <span data-started="declared" className="text-text-secondary [overflow-wrap:anywhere]">
        {starts}
      </span>
    );
  if (restart === null)
    return (
      <span data-started="none" className="text-text-tertiary">
        Nothing started
      </span>
    );
  const status = STATUS[restart.status];
  return (
    <span data-started={restart.status} className="flex min-w-0 items-baseline gap-1">
      <Link
        to={`/console/p/${projectId}/r/${restart.runId}`}
        className={`font-medium hover:underline ${status.color}`}
      >
        {starts ?? `${restart.label} started again`}
      </Link>
      <span className="text-text-tertiary">· {status.words}</span>
    </span>
  );
}
