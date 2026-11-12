import {
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import * as skill from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';

interface EnvVarsDialogProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Per-project env vars. The server never returns values — only keys — so
 * the UI lists key names and uses "Rotate" (a fresh set) as the way to
 * update an existing entry. There's no "view value" affordance because
 * there's no endpoint that exposes one. This is a deliberate constraint:
 * once typed, secrets only leave the box via the agent that runs the
 * project's workflows.
 */
export function EnvVarsDialog({
  projectId,
  projectName,
  open,
  onClose,
}: EnvVarsDialogProps): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Environment variables for ${projectName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-140 overflow-hidden rounded-2xl border bg-surface-elevated p-5.5 text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-0.5 opacity-90" />
        <EnvVarsBody projectId={projectId} projectName={projectName} onClose={onClose} />
      </div>
    </div>
  );
}

interface BodyProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

function EnvVarsBody({ projectId, projectName, onClose }: BodyProps): ReactElement {
  // Drop the cache on every open so the dialog reflects external edits
  // (CLI, other web sessions) instead of whatever was in memory last time.
  useEffect(() => {
    invalidate(K.envVars(projectId));
  }, [projectId]);

  const {
    data: keys,
    error,
    loading,
  } = useEntity<string[]>(K.envVars(projectId), () => skill.listEnvVarKeys(projectId));
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = (): void => {
    invalidate(K.envVars(projectId));
  };

  const upsert = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const k = newKey.trim();
    if (k.length === 0) {
      setActionError('Key is required.');
      return;
    }
    if (newValue.length === 0) {
      setActionError('Value is required.');
      return;
    }
    setActionError(null);
    setBusyKey(k);
    try {
      await skill.setEnvVar(projectId, k, newValue);
      setNewKey('');
      setNewValue('');
      setAdding(false);
      refresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to save env var.');
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (key: string): Promise<void> => {
    if (!window.confirm(`Remove ${key}?`)) return;
    setActionError(null);
    setBusyKey(key);
    try {
      await skill.deleteEnvVar(projectId, key);
      refresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove env var.');
    } finally {
      setBusyKey(null);
    }
  };

  const onAddKeyKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setAdding(false);
      setNewKey('');
      setNewValue('');
      setActionError(null);
    }
  };

  return (
    <>
      <header className="mb-4.5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-console-18 font-extrabold tracking-console-tight text-text-primary">
            Environment variables
          </h2>
          <p className="mt-1 text-console-13 leading-relaxed text-text-tertiary">
            Injected into project-scoped execution (Claude, Codex, bash, scripts). Values are stored
            server-side; the UI only ever sees the names.
          </p>
        </div>
        <span className="shrink-0 truncate pt-1 font-mono text-console-12 text-text-tertiary">
          {projectName}
        </span>
      </header>

      {loading ? (
        <p className="font-mono text-console-11 text-text-tertiary">Loading…</p>
      ) : error !== undefined ? (
        <p className="font-mono text-console-11 text-error">{error.message}</p>
      ) : (
        <ul
          className="mb-3 max-h-[40vh] divide-y divide-border overflow-y-auto rounded-console-12 border bg-surface"
          style={{ borderColor: 'var(--border)' }}
        >
          {(keys ?? []).length === 0 ? (
            <li className="px-5.5 py-5.5 text-center font-mono text-console-13 text-text-tertiary">
              No variables yet.
            </li>
          ) : (
            (keys ?? []).map(key => (
              <li key={key} className="flex items-center justify-between gap-2 p-2 pl-3">
                <span className="truncate font-mono text-console-13 tracking-wide text-text-primary">
                  {key}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(key)}
                  disabled={busyKey === key}
                  title={`Remove ${key}`}
                  aria-label={`Remove ${key}`}
                  className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg border text-text-tertiary transition-colors hover:border-error/40 hover:bg-error/10 hover:text-error disabled:opacity-40"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {adding ? (
        <form
          onSubmit={e => {
            void upsert(e);
          }}
          className="mb-3 rounded-console-12 border bg-surface p-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2.25">
            <input
              value={newKey}
              onChange={e => {
                setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
                if (actionError !== null) setActionError(null);
              }}
              onKeyDown={onAddKeyKey}
              placeholder="NAME"
              autoFocus
              spellCheck={false}
              className="w-[40%] rounded-lg border bg-surface-elevated px-2.75 py-2.25 font-mono text-console-13 tracking-wide text-text-primary placeholder:tracking-normal placeholder:text-text-tertiary focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]"
              style={{ borderColor: 'var(--border-bright)' }}
            />
            <input
              value={newValue}
              type="password"
              onChange={e => {
                setNewValue(e.target.value);
                if (actionError !== null) setActionError(null);
              }}
              onKeyDown={onAddKeyKey}
              placeholder="value (encrypted at rest)"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border bg-surface-elevated px-2.75 py-2.25 font-mono text-console-13 text-text-primary placeholder:text-text-tertiary focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]"
              style={{ borderColor: 'var(--border-bright)' }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
            <span className="font-mono text-console-10 text-text-tertiary">
              ↵ save · esc cancel
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setNewKey('');
                  setNewValue('');
                  setActionError(null);
                }}
                className="rounded-lg px-3 py-1.5 text-console-12 font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey !== null || newKey.trim().length === 0 || newValue.length === 0}
                className="brand-bar rounded-lg px-3.5 py-1.5 text-console-12 font-bold text-white transition-all hover:brightness-110 disabled:opacity-40"
              >
                {busyKey === newKey.trim() ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setAdding(true);
          }}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-console-12 border border-dashed border-border bg-surface px-3 py-3 text-console-13 font-semibold text-text-secondary transition-colors hover:border-accent-bright/50 hover:bg-surface-hover hover:text-text-primary"
        >
          <span aria-hidden className="text-accent-bright">
            +
          </span>
          <span>Add variable</span>
        </button>
      )}

      {actionError !== null ? (
        <p className="mb-2 font-mono text-console-11 text-error">{actionError}</p>
      ) : null}

      <div className="mt-5.5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border bg-transparent px-4.5 py-2.5 text-console-13 font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          Close
        </button>
      </div>
    </>
  );
}
