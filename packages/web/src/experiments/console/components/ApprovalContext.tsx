import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { RunEvent, TextEvent } from '../primitives/event';
import type { Run } from '../primitives/run';

interface ApprovalContextProps {
  run: Run;
}

interface RunDetailView {
  run: unknown;
  events: RunEvent[];
}

const PREVIEW_CHARS = 520;

function isTextEvent(e: RunEvent): e is TextEvent {
  return e.kind === 'text';
}

/** Trim markdown to a single paragraph + line-level slice under PREVIEW_CHARS. */
function previewOf(content: string): { text: string; truncated: boolean } {
  const trimmed = content.trim();
  if (trimmed.length <= PREVIEW_CHARS) return { text: trimmed, truncated: false };
  // Prefer to cut on a paragraph boundary near the end of the preview window.
  const slice = trimmed.slice(-PREVIEW_CHARS);
  const nlIdx = slice.indexOf('\n\n');
  const preview = nlIdx > 0 && nlIdx < PREVIEW_CHARS - 120 ? slice.slice(nlIdx + 2) : slice;
  return { text: preview, truncated: true };
}

/**
 * Shows the most recent AI text event for a paused run so the user can see
 * the **actual question** they're being asked to answer (the approval node's
 * own `message` is usually just "answer the questions above"). Loads lazily
 * via getRun() — the backend bundles `events` alongside the run.
 *
 * If the cache already has detail (because the user opened the run recently)
 * this is zero-cost. Otherwise: one fetch per visible paused card, which is
 * acceptable at typical cardinality (0-2 paused runs at once).
 *
 * Demo runs (id prefix `demo-`) render a synthetic example so the preview UI
 * demonstrates the pattern without hitting the backend.
 */
export function ApprovalContext({ run }: ApprovalContextProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const isDemo = run.id.startsWith('demo-');

  const { data } = useEntity<RunDetailView>(K.run(run.id), () =>
    isDemo ? Promise.resolve({ run: null, events: demoEventsFor(run) }) : skill.getRun(run.id)
  );

  const lastText = useMemo<TextEvent | null>(() => {
    const events = data?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e !== undefined && isTextEvent(e)) return e;
    }
    return null;
  }, [data?.events]);

  if (lastText === null) return null;

  const { text, truncated } = previewOf(lastText.content);
  const showFull = expanded ? lastText.content.trim() : text;

  return (
    <div className="mt-2 rounded border border-border bg-surface-inset/60 p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-text-tertiary">
          What the agent is asking
        </span>
        {run.projectId !== null && !isDemo ? (
          <Link
            to={`/console/p/${run.projectId}/r/${run.id}`}
            className="text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
            onClick={e => {
              e.stopPropagation();
            }}
          >
            Open full run →
          </Link>
        ) : null}
      </div>
      <div className="markdown-preview whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-primary">
        {showFull}
      </div>
      {truncated ? (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            setExpanded(v => !v);
          }}
          className="mt-1 font-mono text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
        >
          {expanded ? '← Collapse' : 'Show full message →'}
        </button>
      ) : null}
    </div>
  );
}

/** Synthetic last-agent-message for demo runs so preview UIs work. */
function demoEventsFor(run: Run): RunEvent[] {
  const now = Date.now();
  const text = synthFor(run);
  return [
    {
      id: `${run.id}-demo-text`,
      runId: run.id,
      kind: 'text',
      nodeId: run.approval?.nodeId ?? null,
      timestamp: new Date(now - 60_000).toISOString(),
      content: text,
    },
  ];
}

function synthFor(run: Run): string {
  if (run.workflow.includes('prd') || run.workflow === 'plan') {
    return [
      '## Foundation Questions',
      '',
      "Here's what I understand so far — now please answer these so I can shape the research phase:",
      '',
      '1. **Who** has this problem? Be specific — not just "users" but what type of person/role?',
      '2. **What** problem are they facing? Describe the observable pain, not the assumed need.',
      "3. **Why** can't they solve it today? What alternatives exist and why do they fail?",
      '4. **Why now?** What changed that makes this worth building?',
      '5. **How** will you know if you solved it? What would success look like?',
    ].join('\n');
  }
  if (run.workflow === 'review') {
    return [
      "I've walked the diff end-to-end against the plan. Overall the implementation tracks.",
      '',
      'Before I open the PR I need your sign-off on two things:',
      '',
      '- The `listWorktrees` selector joins on `working_path` (brittle until the backend exposes `bound_run_id`) — OK to ship as-is and revisit, or block on the backend change?',
      '- Tests cover the happy path but not the stale-env cleanup branch — should I add coverage before PR, or file a follow-up issue?',
    ].join('\n');
  }
  return (
    run.approval?.message ??
    'The agent is waiting for your input. Open the full run to see the conversation.'
  );
}
