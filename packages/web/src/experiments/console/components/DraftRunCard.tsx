import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useSearchParams } from 'react-router';
import { WorkflowPicker } from './WorkflowPicker';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Workflow } from '../primitives/workflow';

interface DraftRunCardProps {
  projectId: string;
  projectCwd: string;
}

type Mode = 'collapsed' | 'expanded';

const LAST_WORKFLOW_KEY = 'archon.console.lastWorkflow';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Client-side accept hint; the server is the security boundary. */
const ACCEPT_HINT =
  'text/*,image/*,application/pdf,.md,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.py,.go,.rs,.sh,.sql,.html,.css';

function formatBytes(n: number): string {
  if (n < 1024) return `${n.toString()} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // One-shot flag set by the global `n` keybind. When true, expanding the
  // card auto-opens the workflow picker (so the user can filter + pick
  // before touching the context box).
  const summonedRef = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>('collapsed');
  const [workflowName, setWorkflowName] = useState<string>(() => readLastWorkflow());
  const [context, setContext] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from `?rerun=1&workflow=…&message=…` query params (set by the
  // ↻ rerun button on RecentRunRow). Reacts to searchParams so the card
  // expands whether you arrive by navigation (same project, params change
  // only) or by a fresh mount. Strips the params on entry so reload
  // doesn't re-trigger and so the URL stays clean.
  useEffect(() => {
    if (searchParams.get('rerun') !== '1') return;
    const wf = searchParams.get('workflow');
    const msg = searchParams.get('message');
    if (wf !== null && wf.length > 0) setWorkflowName(wf);
    if (msg !== null) setContext(msg);
    setMode('expanded');
    const next = new URLSearchParams(searchParams);
    next.delete('rerun');
    next.delete('workflow');
    next.delete('message');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const addFiles = (incoming: File[]): void => {
    if (incoming.length === 0) return;
    const oversize = incoming.find(f => f.size > MAX_FILE_BYTES);
    if (oversize !== undefined) {
      setError(`"${oversize.name}" is larger than 10 MB.`);
      return;
    }
    setFiles(prev => {
      const merged = [...prev, ...incoming];
      if (merged.length > MAX_FILES) {
        setError(`Max ${MAX_FILES.toString()} files per run.`);
        return merged.slice(0, MAX_FILES);
      }
      setError(null);
      return merged;
    });
  };

  const removeFile = (idx: number): void => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

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

  // Global `N` keybind: expand + open the workflow picker so the user can
  // pick a workflow without first reaching for the mouse.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typingElsewhere =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typingElsewhere) return;
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        summonedRef.current = true;
        setMode('expanded');
      }
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, []);

  // After entering expanded mode, either open the workflow picker (when
  // summoned via `n`) or focus the textarea (every other path: click, rerun
  // query params). The summon-open is fire-and-forget — closing the picker
  // hands focus to the textarea via the WorkflowPicker.onClose callback.
  useEffect(() => {
    if (mode !== 'expanded') return;
    requestAnimationFrame(() => {
      if (summonedRef.current) {
        summonedRef.current = false;
        const trigger = document.querySelector<HTMLButtonElement>('[data-keymap-workflow-trigger]');
        if (trigger !== null && !trigger.disabled) {
          trigger.click();
          return;
        }
      }
      inputRef.current?.focus();
    });
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
      await skill.startRun({
        projectId,
        workflow: workflowName,
        message: context,
        files: files.length > 0 ? files : undefined,
      });
      // Dispatch is fire-and-forget — the orchestrator creates the run row
      // asynchronously. Nudge the runs feed so the new card appears as soon
      // as the row exists, instead of waiting for the next 3s poll tick.
      setContext('');
      setFiles([]);
      setMode('collapsed');
      invalidate('runs');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start run.');
    } finally {
      setSubmitting(false);
    }
  };

  const collapse = (): void => {
    setMode('collapsed');
    setFiles([]);
    setError(null);
  };

  const onTextareaKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Don't submit while an IME composition is in progress (Japanese,
    // Chinese, Korean, etc. — the first Enter accepts a candidate).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    // Only un-flag when leaving the bounding rect, not on each child crossover.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) addFiles(dropped);
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(e.clipboardData.items);
    const pastedFiles: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f !== null) pastedFiles.push(f);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFiles(pastedFiles);
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
        // Soft-magenta hairline border on all four sides; the brand-gradient
        // strip is painted as an absolute child so the card can keep
        // `overflow: visible` (the workflow picker's dropdown escapes these
        // bounds).
        borderColor: 'color-mix(in oklch, var(--brand-magenta), transparent 60%)',
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span
        aria-hidden
        className="brand-bar pointer-events-none absolute left-0 top-0 bottom-0 w-1 rounded-l"
      />
      {dragOver ? (
        <div
          aria-hidden
          className="brand-bar-soft pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded"
        >
          <span className="rounded border border-[color:var(--brand-magenta)] bg-surface px-3 py-1.5 font-mono text-[11px] text-[color:var(--brand-magenta)]">
            drop files to attach
          </span>
        </div>
      ) : null}
      <div className="pl-5 pr-4 py-3">
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
            onClose={() => {
              requestAnimationFrame(() => {
                inputRef.current?.focus();
              });
            }}
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
            onPaste={onPaste}
            placeholder={
              workflowName.length > 0
                ? `what should \`${workflowName}\` work on?`
                : 'Pick a workflow to start…'
            }
            rows={2}
            disabled={submitting}
            className="min-h-[52px] w-full resize-none rounded border border-border bg-surface-inset px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
          />

          {files.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, idx) => (
                <li
                  key={`${f.name}:${idx.toString()}`}
                  className="flex items-center gap-1.5 rounded border border-border bg-surface-inset px-2 py-1 font-mono text-[11px] text-text-secondary"
                >
                  <span aria-hidden>📎</span>
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <span className="text-text-tertiary">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      removeFile(idx);
                    }}
                    disabled={submitting}
                    className="ml-1 rounded p-0.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error disabled:opacity-40"
                    aria-label={`Remove ${f.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_HINT}
            className="hidden"
            onChange={e => {
              const picked = e.target.files === null ? [] : Array.from(e.target.files);
              addFiles(picked);
              // Allow re-picking the same file: reset so onChange fires next time.
              e.target.value = '';
            }}
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  fileInputRef.current?.click();
                }}
                disabled={submitting || files.length >= MAX_FILES}
                className="flex items-center gap-1 rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
                title={
                  files.length >= MAX_FILES
                    ? `Max ${MAX_FILES.toString()} files attached`
                    : 'Attach files · drop or paste also work'
                }
                aria-label="Attach files"
              >
                <span aria-hidden className="text-[12px]">
                  📎
                </span>
              </button>
              <span className="font-mono text-[10px] text-text-tertiary">
                ↵ start · ⇧↵ newline · esc cancel
              </span>
            </div>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || workflowName.length === 0}
              className="brand-bar flex items-center gap-1 rounded px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-all hover:brightness-110 active:brightness-95 disabled:opacity-50"
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
