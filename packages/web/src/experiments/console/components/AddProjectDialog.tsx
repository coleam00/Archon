import { useState, type FormEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import type { Project } from '../primitives/project';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (project: Project) => void;
}

type Mode = 'url' | 'path';

export function AddProjectDialog({
  open,
  onClose,
  onAdded,
}: AddProjectDialogProps): ReactElement | null {
  const [mode, setMode] = useState<Mode>('url');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const project =
        mode === 'url'
          ? await skill.addProjectByUrl(value.trim())
          : await skill.addProjectByPath(value.trim());
      onAdded(project);
      setValue('');
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={e => {
          void onSubmit(e);
        }}
        onClick={e => {
          e.stopPropagation();
        }}
        className="w-full max-w-md rounded-md border border-border bg-surface-elevated p-5 text-text-primary shadow-xl"
      >
        <h2 className="text-sm font-semibold">Add project</h2>

        <div className="mt-4 flex gap-1 rounded border border-border p-0.5">
          {(['url', 'path'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
              }}
              className={`flex-1 rounded px-2 py-1 text-xs uppercase tracking-wide transition-colors ${
                mode === m
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-primary'
              }`}
              aria-pressed={mode === m}
            >
              {m === 'url' ? 'GitHub URL' : 'Local path'}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-[11px] uppercase tracking-wider text-text-tertiary">
          {mode === 'url' ? 'Repository URL' : 'Absolute path'}
        </label>
        <input
          type="text"
          value={value}
          onChange={e => {
            setValue(e.target.value);
          }}
          autoFocus
          placeholder={
            mode === 'url' ? 'https://github.com/owner/repo' : '/Users/you/Projects/my-repo'
          }
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
          disabled={submitting}
        />
        <p className="mt-2 text-[11px] text-text-tertiary">
          {mode === 'url'
            ? 'Archon will clone this repo to ~/.archon/workspaces/owner/repo/source/.'
            : 'Archon will register this path directly — no clone.'}
        </p>

        {error !== null ? (
          <p className="mt-3 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[11px] text-error">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || value.trim().length === 0}
            className="rounded bg-accent-bright px-3 py-1.5 text-sm font-medium text-white/95 transition-opacity hover:brightness-110 disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
