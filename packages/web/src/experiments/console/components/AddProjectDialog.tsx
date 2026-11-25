import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import type { BaseBranchInspection } from '../skills/projects';
import type { Project } from '../primitives/project';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (project: Project) => void;
}

type Mode = 'url' | 'path';

// console-token-exception w-[calc(50%-4px)] -- Segment indicator subtracts its local inset from half the control.
const SEGMENT_WIDTH = 'w-[calc(50%-4px)]';

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

  const [folder, setFolder] = useState(false);
  const [branch, setBranch] = useState('');
  const [inspection, setInspection] = useState<{
    source: string;
    result: BaseBranchInspection;
  } | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const source = `${mode}:${value.trim()}`;
  const explicitFolder = mode === 'path' && folder;
  const currentInspection =
    !explicitFolder && inspection?.source === source ? inspection.result : null;

  useEffect(() => {
    if (!open) setFolder(false);
  }, [open]);

  useEffect(() => {
    setBranch('');
    setInspection(null);
    setInspectionError(null);
    if (!open || !value.trim() || explicitFolder) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void skill
        .inspectProjectBaseBranch(mode === 'url' ? { url: value.trim() } : { path: value.trim() })
        .then(
          result => {
            if (!active) return;
            setInspection({ source, result });
            setBranch(result.kind === 'repo' ? (result.defaultBranch ?? '') : '');
          },
          (err: unknown) => {
            if (active)
              setInspectionError(
                err instanceof Error ? err.message : 'Could not inspect the project.'
              );
          }
        );
    }, 300);
    return (): void => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, mode, value, source, explicitFolder]);

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
    if (!value.trim() || (!explicitFolder && (!currentInspection || inspectionError))) return;
    const baseBranch =
      currentInspection?.kind === 'repo' &&
      branch.trim() &&
      branch.trim() !== currentInspection.defaultBranch
        ? branch.trim()
        : null;
    setError(null);
    setSubmitting(true);
    try {
      const project = isGit
        ? await skill.addProjectByUrl(value.trim(), baseBranch)
        : await skill.addProjectByPath(value.trim(), baseBranch, explicitFolder);
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
        className="relative w-full max-w-130 overflow-hidden rounded-2xl border bg-surface-elevated p-5.5 text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        {/* Brand gradient top accent */}
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-0.5 opacity-90" />

        {/* Header */}
        <div className="mb-4.5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-console-18 font-extrabold tracking-console-tight text-text-primary">
              Add project
            </h2>
            <p className="mt-1 text-console-13 text-text-tertiary">
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
            <span aria-hidden className="block text-console-14 leading-none">
              ✕
            </span>
          </button>
        </div>

        {/* Segmented control with sliding indicator */}
        <div
          className="relative mb-5 grid grid-cols-2 rounded-console-12 border bg-surface p-1"
          style={{ borderColor: 'var(--border)' }}
        >
          <span
            aria-hidden
            className={`absolute bottom-1 left-1 top-1 ${SEGMENT_WIDTH} rounded-lg border bg-surface-hover transition-transform duration-200 ease-out`}
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
                setFolder(false);
              }}
              aria-pressed={mode === m}
              className={`relative z-[1] flex items-center justify-center gap-2 rounded-lg px-3 py-2.25 text-console-13 font-semibold transition-colors ${
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
        <label className="mb-2.25 block font-mono text-console-11 font-semibold uppercase tracking-widest text-text-tertiary">
          {isGit ? 'Repository URL' : 'Local folder path'}
        </label>
        <div
          className="flex h-11.5 items-center gap-2.5 rounded-console-12 border bg-surface px-3.5 transition-all focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_91%)]"
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
            placeholder={isGit ? 'https://github.com/owner/repo' : '/path/to/my-repo'}
            className="min-w-0 flex-1 bg-transparent font-mono text-console-14 text-text-primary outline-none placeholder:text-text-tertiary"
            disabled={submitting}
          />
        </div>
        <p className="mt-2.75 text-console-13 leading-relaxed text-text-tertiary">
          {isGit ? (
            <>
              Archon will clone this repo to{' '}
              <code
                className="rounded border bg-surface px-1.5 py-0.5 font-mono text-console-12 text-text-secondary"
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

        {!isGit ? (
          <label className="mt-4 block text-console-13 text-text-secondary">
            <input
              type="checkbox"
              checked={folder}
              onChange={e => {
                setFolder(e.target.checked);
                setBranch('');
              }}
              disabled={submitting}
            />{' '}
            Register as a folder project
            <span className="mt-1 block text-console-12 text-text-tertiary">
              Run in place with no Archon-managed worktree, branch or PR, even if this is a git
              repository.
            </span>
          </label>
        ) : null}

        {renderBranchInspection({
          currentInspection,
          branch,
          setBranch,
          submitting,
          explicitFolder,
          value,
          inspectionError,
        })}

        {error !== null ? (
          <p className="mt-3 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-console-11 text-error">
            {error}
          </p>
        ) : null}

        {/* Footer */}
        <div className="mt-5.5 flex items-center justify-end gap-2.75">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border bg-transparent px-4.5 py-2.5 text-console-13 font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              submitting ||
              value.trim().length === 0 ||
              (!explicitFolder && (!currentInspection || inspectionError !== null))
            }
            className="brand-bar inline-flex items-center gap-1.75 rounded-lg px-4.5 py-2.5 text-console-13 font-bold text-white shadow-[0_8px_22px_-10px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-45 disabled:shadow-none"
          >
            <span aria-hidden className="text-console-14 leading-none">
              +
            </span>
            {submitting ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </div>
  );
}

function renderBranchInspection({
  currentInspection,
  branch,
  setBranch,
  submitting,
  explicitFolder,
  value,
  inspectionError,
}: {
  currentInspection: BaseBranchInspection | null;
  branch: string;
  setBranch: (branch: string) => void;
  submitting: boolean;
  explicitFolder: boolean;
  value: string;
  inspectionError: string | null;
}): ReactElement {
  return (
    <>
      {currentInspection?.kind === 'repo' ? (
        <label className="mt-4 block text-console-13 text-text-secondary">
          Base branch
          <input
            aria-label="Base branch"
            value={branch}
            onChange={e => {
              setBranch(e.target.value);
            }}
            disabled={submitting}
            className="mt-2 block w-full rounded border bg-surface px-3 py-2 font-mono text-text-primary"
          />
          <span className="mt-1 block text-console-12 text-text-tertiary">
            {currentInspection.defaultBranch
              ? 'Keep this value to follow the remote default, or choose another branch.'
              : 'Remote default unavailable. Leave empty to resolve it when a run starts.'}
          </span>
        </label>
      ) : null}
      {!explicitFolder && value.trim() && !currentInspection && !inspectionError ? (
        <p className="mt-3 text-console-12 text-text-tertiary">Checking remote default…</p>
      ) : null}
      {!explicitFolder && inspectionError ? (
        <p className="mt-3 text-console-12 text-error">{inspectionError}</p>
      ) : null}
    </>
  );
}
