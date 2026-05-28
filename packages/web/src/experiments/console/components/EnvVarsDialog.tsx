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
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Environment variables for ${projectName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={e => {
          e.stopPropagation();
        }}
        className="w-full max-w-md rounded-md border border-border bg-surface-elevated p-5 text-text-primary shadow-xl"
      >
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
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Environment variables</h2>
        <span className="truncate font-mono text-[11px] text-text-tertiary">{projectName}</span>
      </header>
      <p className="mb-4 text-[12px] text-text-secondary">
        Injected into project-scoped execution (Claude, Codex, bash, scripts). Values are stored
        server-side; the UI only ever sees the names.
      </p>

      {loading ? (
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      ) : error !== undefined ? (
        <p className="font-mono text-[11px] text-error">{error.message}</p>
      ) : (
        <ul className="mb-3 max-h-[40vh] divide-y divide-border overflow-y-auto rounded border border-border">
          {(keys ?? []).length === 0 ? (
            <li className="px-3 py-2 text-[12px] text-text-tertiary">No variables yet.</li>
          ) : (
            (keys ?? []).map(key => (
              <li
                key={key}
                className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]"
              >
                <span className="truncate font-mono text-text-primary">{key}</span>
                <button
                  type="button"
                  onClick={() => void remove(key)}
                  disabled={busyKey === key}
                  className="rounded px-2 py-0.5 font-mono text-[10px] text-text-tertiary transition-colors hover:bg-error/10 hover:text-error disabled:opacity-40"
                >
                  {busyKey === key ? '…' : 'remove'}
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
          className="mb-3 space-y-2 rounded border border-border bg-surface-inset p-3"
        >
          <input
            value={newKey}
            onChange={e => {
              setNewKey(e.target.value.toUpperCase());
              if (actionError !== null) setActionError(null);
            }}
            onKeyDown={onAddKeyKey}
            placeholder="KEY_NAME"
            autoFocus
            className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
          />
          <input
            value={newValue}
            type="password"
            onChange={e => {
              setNewValue(e.target.value);
              if (actionError !== null) setActionError(null);
            }}
            onKeyDown={onAddKeyKey}
            placeholder="value (will be encrypted at rest)"
            className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-text-tertiary">↵ save · esc cancel</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setNewKey('');
                  setNewValue('');
                  setActionError(null);
                }}
                className="rounded px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey !== null || newKey.trim().length === 0 || newValue.length === 0}
                className="brand-bar rounded px-3 py-0.5 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
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
          className="mb-3 flex w-full items-center justify-center gap-2 rounded border border-dashed border-border px-2.5 py-1.5 text-[12px] text-text-tertiary transition-colors hover:border-[color:var(--brand-magenta)]/40 hover:bg-surface-hover hover:text-text-primary"
        >
          <span aria-hidden>+</span>
          <span>Add variable</span>
        </button>
      )}

      {actionError !== null ? (
        <p className="mb-2 font-mono text-[11px] text-error">{actionError}</p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          Close
        </button>
      </div>
    </>
  );
}
