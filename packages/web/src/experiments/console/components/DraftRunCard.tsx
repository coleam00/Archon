import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useNavigate } from 'react-router';
import { WorkflowPicker } from './WorkflowPicker';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Workflow } from '../primitives/workflow';

interface DraftRunCardProps {
  projectId: string;
  projectCwd: string;
}

type Mode = 'collapsed' | 'expanded';

const LAST_WORKFLOW_KEY = 'archon.console.lastWorkflow';

function readLastWorkflow(): string {
  try {
    return localStorage.getItem(LAST_WORKFLOW_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeLastWorkflow(name: string): void {
  try {
    localStorage.setItem(LAST_WORKFLOW_KEY, name);
  } catch {
    /* ignore */
  }
}

/**
 * DraftRunCard — the "start a run" primitive, rendered as a card that lives
 * at the top of the Active list.
 *
 * Two modes:
 *   collapsed   thin `+ Start a new run` row
 *   expanded    full card with workflow picker + context textarea + Start
 *
 * Mental model: same shape as a paused-approval card. One is "the agent is
 * waiting for you," the other is "you are about to kick off the agent." Both
 * surface the same input primitive in the same place.
 *
 * Keybind: `N` anywhere (except while typing in another input) opens the
 * expanded state and focuses the textarea. Enter starts; Esc collapses.
 */
export function DraftRunCard({ projectId, projectCwd }: DraftRunCardProps): ReactElement {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<Mode>('collapsed');
  const [workflowName, setWorkflowName] = useState<string>(() => readLastWorkflow());
  const [context, setContext] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: workflows } = useEntity<Workflow[]>(K.workflows(projectCwd), () =>
    skill.listWorkflows(projectCwd)
  );

  // Sort project-scoped first, then global, then bundled; alpha within each.
  const sortedWorkflows = (workflows ?? []).slice().sort((a, b) => {
    const rank = { project: 0, global: 1, bundled: 2 } as const;
    return rank[a.source] - rank[b.source] || a.name.localeCompare(b.name);
  });

  // Default workflow: last-used if still valid, else first available.
  useEffect(() => {
    if (sortedWorkflows.length === 0) return;
    if (workflowName.length > 0 && sortedWorkflows.some(w => w.name === workflowName)) {
      return;
    }
    const pick = sortedWorkflows[0];
    if (pick !== undefined) setWorkflowName(pick.name);
  }, [sortedWorkflows, workflowName]);

  // Global `N` keybind: expand + focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typingElsewhere =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typingElsewhere) return;
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setMode('expanded');
      }
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, []);

  // Focus the textarea whenever we enter expanded mode.
  useEffect(() => {
    if (mode === 'expanded') {
      // Defer by one frame so the textarea exists + layout is flushed.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [mode]);

  const submit = async (): Promise<void> => {
    if (workflowName.length === 0) {
      setError('Pick a workflow first.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      writeLastWorkflow(workflowName);
      const started = await skill.startRun({
        projectId,
        workflow: workflowName,
        message: context,
      });
      setContext('');
      setMode('collapsed');
      navigate(`/console/p/${projectId}/r/${started.runId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start run.');
    } finally {
      setSubmitting(false);
    }
  };

  const collapse = (): void => {
    setMode('collapsed');
    setError(null);
  };

  const onTextareaKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      collapse();
    }
  };

  if (mode === 'collapsed') {
    return (
      <button
        type="button"
        onClick={() => {
          setMode('expanded');
        }}
        className="group flex items-center gap-3 rounded border border-dashed border-border px-3 py-2 text-left transition-colors hover:border-accent-bright/60 hover:bg-surface-hover"
        title="Start a new run — press N"
      >
        <span
          aria-hidden
          className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-text-tertiary transition-colors group-hover:border-accent-bright/60 group-hover:text-accent-bright"
        >
          +
        </span>
        <span className="text-[12px] text-text-tertiary transition-colors group-hover:text-text-primary">
          Start a new run
        </span>
        <span
          aria-hidden
          className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-tertiary"
        >
          N
        </span>
      </button>
    );
  }

  return (
    <article
      className="relative rounded border bg-surface"
      style={{
        // 4-px accent strip as a left border so we can keep `overflow: visible`
        // on the card — the workflow picker's dropdown escapes these bounds.
        borderColor: 'color-mix(in oklch, var(--accent-bright), transparent 60%)',
        borderLeftWidth: 4,
        borderLeftColor: 'var(--accent-bright)',
      }}
    >
      <div className="px-4 py-3">
        {/* Header: status dot + DRAFT label + workflow picker + close */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent-bright" />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-bright">
            Draft
          </span>
          <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
          <WorkflowPicker
            workflows={sortedWorkflows}
            value={workflowName}
            onChange={setWorkflowName}
            disabled={submitting}
          />
          <button
            type="button"
            onClick={collapse}
            disabled={submitting}
            className="ml-auto rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            aria-label="Cancel draft"
            title="Cancel (Esc)"
          >
            <span aria-hidden className="text-[12px]">
              ✕
            </span>
          </button>
        </div>

        {/* Body: context textarea */}
        <div className="mt-3">
          <textarea
            ref={inputRef}
            value={context}
            onChange={e => {
              setContext(e.target.value);
              if (error !== null) setError(null);
            }}
            onKeyDown={onTextareaKey}
            placeholder={
              workflowName.length > 0
                ? `what should \`${workflowName}\` work on?`
                : 'Pick a workflow to start…'
            }
            rows={2}
            disabled={submitting}
            className="min-h-[52px] w-full resize-none rounded border border-border bg-surface-inset px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-text-tertiary">
              ↵ start · ⇧↵ newline · esc cancel
            </span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || workflowName.length === 0}
              className="flex items-center gap-1 rounded bg-accent-bright px-3 py-1.5 text-[12px] font-medium text-white/95 transition-all hover:brightness-110 active:brightness-95 disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start run'}
              <span aria-hidden className="font-mono text-[10px] opacity-70">
                ↵
              </span>
            </button>
          </div>

          {error !== null ? <p className="mt-1 font-mono text-[11px] text-error">{error}</p> : null}
        </div>
      </div>
    </article>
  );
}
