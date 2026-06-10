import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import type { Project } from '../primitives/project';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (project: Project) => void;
}

type Mode = 'url' | 'path';

function GitHubIcon({ size = 15 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.06 10.06 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

function FolderIcon({ size = 15 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LinkIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** Derive an `owner/repo` preview from a GitHub URL for the clone-path hint. */
function parseGitHubUrl(value: string): { owner: string; repo: string } {
  const m = /github\.com[/:]+([^/]+)\/([^/#?]+)/i.exec(value);
  if (m === null) return { owner: 'owner', repo: 'repo' };
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/**
 * Add-project modal, design v4: blurred scrim, centered 520px card with a
 * brand-gradient top accent, segmented GitHub/Local control with a sliding
 * indicator, 46px icon input with magenta focus ring, and a live clone-path
 * hint derived from the typed URL. Esc, ✕, Cancel, and the backdrop close it.
 */
export function AddProjectDialog({
  open,
  onClose,
  onAdded,
}: AddProjectDialogProps): ReactElement | null {
  const [mode, setMode] = useState<Mode>('url');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const isGit = mode === 'url';
  const { owner, repo } = parseGitHubUrl(value);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const project = isGit
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <form
        onSubmit={e => {
          void onSubmit(e);
        }}
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-[520px] overflow-hidden rounded-2xl border bg-surface-elevated p-[22px] text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        {/* Brand gradient top accent */}
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />

        {/* Header */}
        <div className="mb-[18px] flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-extrabold tracking-[-0.3px] text-text-primary">
              Add project
            </h2>
            <p className="mt-1 text-[13px] text-text-tertiary">
              Connect a repository or a local folder as a workspace.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <span aria-hidden className="block text-[14px] leading-none">
              ✕
            </span>
          </button>
        </div>

        {/* Segmented control with sliding indicator */}
        <div
          className="relative mb-5 grid grid-cols-2 rounded-[11px] border bg-surface p-1"
          style={{ borderColor: 'var(--border)' }}
        >
          <span
            aria-hidden
            className="absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded-lg border bg-surface-hover transition-transform duration-200 ease-out"
            style={{
              borderColor: 'var(--border-bright)',
              transform: isGit ? 'translateX(0)' : 'translateX(100%)',
            }}
          />
          {(['url', 'path'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
              }}
              aria-pressed={mode === m}
              className={`relative z-[1] flex items-center justify-center gap-2 rounded-lg px-3 py-[9px] text-[13px] font-semibold transition-colors ${
                mode === m ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <span aria-hidden className="flex">
                {m === 'url' ? <GitHubIcon /> : <FolderIcon />}
              </span>
              {m === 'url' ? 'GitHub URL' : 'Local path'}
            </button>
          ))}
        </div>

        {/* Field */}
        <label className="mb-[9px] block font-mono text-[11px] font-semibold uppercase tracking-[0.09em] text-text-tertiary">
          {isGit ? 'Repository URL' : 'Local folder path'}
        </label>
        <div
          className="flex h-[46px] items-center gap-2.5 rounded-[11px] border bg-surface px-3.5 transition-all focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_91%)]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <span aria-hidden className="flex text-text-tertiary">
            {isGit ? <LinkIcon /> : <FolderIcon size={16} />}
          </span>
          <input
            type="text"
            value={value}
            onChange={e => {
              setValue(e.target.value);
            }}
            autoFocus
            spellCheck={false}
            placeholder={
              isGit ? 'https://github.com/owner/repo' : 'C:\\Users\\you\\projects\\my-repo'
            }
            className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
            disabled={submitting}
          />
        </div>
        <p className="mt-[11px] text-[12.5px] leading-relaxed text-text-tertiary">
          {isGit ? (
            <>
              Archon will clone this repo to{' '}
              <code
                className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[0.92em] text-text-secondary"
                style={{ borderColor: 'var(--border)' }}
              >
                ~/.archon/workspaces/{owner}/{repo}/source
              </code>
              .
            </>
          ) : (
            <>
              Archon will use this existing folder as the project source — nothing is copied or
              moved.
            </>
          )}
        </p>

        {error !== null ? (
          <p className="mt-3 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[11px] text-error">
            {error}
          </p>
        ) : null}

        {/* Footer */}
        <div className="mt-[22px] flex items-center justify-end gap-[11px]">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-[10px] border bg-transparent px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || value.trim().length === 0}
            className="brand-bar inline-flex items-center gap-[7px] rounded-[10px] px-[18px] py-2.5 text-[13px] font-bold text-white shadow-[0_8px_22px_-10px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-45 disabled:shadow-none"
          >
            <span aria-hidden className="text-[14px] leading-none">
              +
            </span>
            {submitting ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </div>
  );
}
