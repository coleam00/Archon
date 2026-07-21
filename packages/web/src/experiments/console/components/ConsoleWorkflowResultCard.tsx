import { useEffect, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import { countTerminalNodes } from '../primitives/event';
import type { RunStatus } from '../lib/run-status';
import { statusLabel } from '../lib/run-status';
import { formatElapsed, elapsedSince, formatCost } from '../lib/format';

interface ConsoleWorkflowResultCardProps {
  runId: string;
  workflowName: string;
  /** The orchestrator's summary prose (the message content). Rendered as the body. */
  summary: string;
}

// Only terminal statuses get a dedicated glyph/label — this is a *completion* card.
// A still-`running`/`paused` run reaches here only in a brief race (the card mounts
// before getRun reflects completion); those fall back to the generic glyph + label.
const RESULT_GLYPH: Partial<Record<RunStatus, string>> = {
  completed: '✓',
  failed: '✕',
  cancelled: '◌',
};

const RESULT_LABEL: Partial<Record<RunStatus, string>> = {
  completed: 'Workflow complete',
  failed: 'Workflow failed',
  cancelled: 'Workflow cancelled',
};

interface AccentTheme {
  bar: string;
  badgeBg: string;
  badgeFg: string;
  cardBorder: string;
  cardBg: string;
}

// Status → accent palette. Color-mix derives soft tints from the brand token
// rather than hard-coded hex, so the card tracks any future token change.
const ACCENT_BY_STATUS: Partial<Record<RunStatus, AccentTheme>> = {
  completed: {
    bar: 'var(--brand-teal)',
    badgeBg: 'color-mix(in oklch, var(--brand-teal), transparent 84%)',
    badgeFg: 'var(--brand-teal)',
    cardBorder: 'var(--border)',
    cardBg: 'var(--surface-elevated)',
  },
  failed: {
    bar: 'var(--error)',
    badgeBg: 'color-mix(in oklch, var(--error), transparent 84%)',
    badgeFg: 'var(--error)',
    cardBorder: 'color-mix(in oklch, var(--error), transparent 68%)',
    cardBg: 'color-mix(in oklch, var(--error), transparent 94%)',
  },
  cancelled: {
    bar: 'var(--text-tertiary)',
    badgeBg: 'color-mix(in oklch, var(--text-tertiary), transparent 84%)',
    badgeFg: 'var(--text-tertiary)',
    cardBorder: 'var(--border)',
    cardBg: 'var(--surface-elevated)',
  },
};

const FALLBACK_ACCENT: AccentTheme = {
  bar: 'var(--text-tertiary)',
  badgeBg: 'color-mix(in oklch, var(--text-tertiary), transparent 84%)',
  badgeFg: 'var(--text-tertiary)',
  cardBorder: 'var(--border)',
  cardBg: 'var(--surface-elevated)',
};

/**
 * A formatted card for a `workflow_result` chat message: status + node counts +
 * duration + cost + a link to the run detail, with the summary prose as the body.
 * Fetches authoritative run state via `skill.getRun` (the same call RunDetailPage
 * uses). While the run is still loading, or if it can't be loaded at all (deleted,
 * or a fetch error), it degrades to the summary prose alone rather than rendering a
 * broken card.
 */
export function ConsoleWorkflowResultCard({
  runId,
  workflowName,
  summary,
}: ConsoleWorkflowResultCardProps): ReactElement {
  const navigate = useNavigate();
  const { data, error } = useEntity<Awaited<ReturnType<typeof skill.getRun>>>(K.run(runId), () =>
    skill.getRun(runId)
  );

  // useEntity surfaces a fetch failure as `error` (Error | undefined). Don't let it
  // vanish silently — the card already falls back to the summary, but a transient
  // 500 looks identical to a deleted run without this breadcrumb.
  useEffect(() => {
    if (error !== undefined) {
      console.warn('[console] workflow result card: getRun failed, showing summary only', {
        runId,
        message: error.message,
      });
    }
  }, [error, runId]);

  // `error` is `Error | undefined` (never null) — compare against undefined, else
  // the rich card never renders. Loading (data undefined) and error both → summary.
  const run = error !== undefined ? null : (data?.run ?? null);

  // Loading or unfetchable → summary only (never a broken/empty card).
  // Intentionally NO accent strip here: showing a colored "completed/failed" badge
  // would lie about a state we couldn't load.
  if (run === null) {
    return (
      <div className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] whitespace-pre-wrap text-text-secondary">
        {summary}
      </div>
    );
  }

  const { completed, total } = countTerminalNodes(data?.events ?? []);
  const glyph = RESULT_GLYPH[run.status] ?? '•';
  const label = RESULT_LABEL[run.status] ?? `Workflow ${statusLabel[run.status].toLowerCase()}`;
  const duration = formatElapsed(elapsedSince(run.startedAt, run.finishedAt ?? undefined));
  const cost = run.costUsd !== null ? formatCost(run.costUsd) : null;
  const accent = ACCENT_BY_STATUS[run.status] ?? FALLBACK_ACCENT;

  return (
    <article
      className="relative flex items-start gap-[13px] overflow-hidden rounded-[12px] border px-4 py-[14px]"
      style={{ borderColor: accent.cardBorder, background: accent.cardBg }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: accent.bar }}
      />
      <div
        aria-hidden
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] text-[17px] font-semibold"
        style={{ background: accent.badgeBg, color: accent.badgeFg }}
      >
        {glyph}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[14px] font-bold leading-[1.35]">
          <span className="whitespace-nowrap" style={{ color: accent.badgeFg }}>
            {label}:
          </span>
          <span
            className="rounded-[6px] border px-[9px] py-[3px] font-mono text-[12px] font-semibold text-text-primary"
            style={{ background: 'var(--surface)', borderColor: 'var(--border-bright)' }}
          >
            {workflowName}
          </span>
          {run.status === 'failed' ? (
            <span
              className="rounded-full border px-[7px] py-[2px] font-mono text-[10.5px] font-semibold uppercase tracking-[0.6px]"
              style={{
                color: 'var(--error)',
                borderColor: 'color-mix(in oklch, var(--error), transparent 60%)',
              }}
            >
              exit 1
            </span>
          ) : null}
        </div>
        <div className="mt-[5px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-[1.55] text-text-secondary">
          <span className="font-mono text-[11px] text-text-tertiary">{duration}</span>
          {total > 0 ? (
            <span className="font-mono text-[11px] text-text-tertiary">
              {completed}/{total} nodes
            </span>
          ) : null}
          {cost !== null ? (
            <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[10px] text-text-tertiary">
              {cost}
            </span>
          ) : null}
          {run.projectId !== null ? (
            <button
              type="button"
              onClick={(): void => {
                void navigate(`/console/p/${run.projectId}/r/${runId}`);
              }}
              className="ml-auto text-[11px] text-text-secondary transition-colors hover:text-text-primary"
            >
              Open run →
            </button>
          ) : null}
        </div>
        {summary.trim().length > 0 ? (
          <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">
            {summary}
          </div>
        ) : null}
      </div>
    </article>
  );
}
