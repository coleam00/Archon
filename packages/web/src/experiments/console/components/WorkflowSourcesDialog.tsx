import { useEffect, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity, invalidate, set as setCached } from '../store/cache';
import { K } from '../store/keys';

interface WorkflowSourcesDialogProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Git refs of the project's own repository whose workflows it loads, such as a `plans`
 * branch. The refs are configured in `.archon/config.yaml` (`extraWorkflowSources`), so
 * this dialog only shows them and runs the one action that fetches them. Nothing syncs on
 * its own, and a run uses the commit shown here.
 */
export function WorkflowSourcesDialog({
  projectId,
  projectName,
  open,
  onClose,
}: WorkflowSourcesDialogProps): ReactElement | null {
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
      aria-label={`Workflow sources for ${projectName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-[560px] overflow-hidden rounded-2xl border bg-surface-elevated p-[22px] text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />
        <SourcesBody projectId={projectId} projectName={projectName} onClose={onClose} />
      </div>
    </div>
  );
}

interface BodyProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function SourcesBody({ projectId, projectName, onClose }: BodyProps): ReactElement {
  // Drop the cache on every open so the dialog shows what the CLI or another session
  // synced since, not whatever was in memory last time.
  useEffect(() => {
    invalidate(K.extraSources(projectId));
  }, [projectId]);

  const {
    data: sources,
    error,
    loading,
  } = useEntity<skill.ExtraSourceStatus[]>(K.extraSources(projectId), () =>
    skill.listExtraSources(projectId)
  );
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const sync = async (): Promise<void> => {
    setSyncError(null);
    setSyncing(true);
    try {
      setCached(K.extraSources(projectId), await skill.syncExtraSources(projectId));
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : 'Failed to sync workflow sources.');
    } finally {
      setSyncing(false);
    }
  };

  const configured = sources ?? [];

  return (
    <>
      <header className="mb-[18px] flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-extrabold tracking-[-0.3px] text-text-primary">
            Workflow sources
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-text-tertiary">
            Git refs of this repository whose workflows the project loads. Nothing refreshes them in
            the background: a run uses the commit shown here until you sync.
          </p>
        </div>
        <span className="shrink-0 truncate pt-1 font-mono text-[12px] text-text-tertiary">
          {projectName}
        </span>
      </header>

      {loading ? (
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      ) : error !== undefined ? (
        <p className="font-mono text-[11px] text-error">{error.message}</p>
      ) : (
        <ul
          className="mb-3 max-h-[40vh] divide-y divide-border overflow-y-auto rounded-[11px] border bg-surface"
          style={{ borderColor: 'var(--border)' }}
        >
          {configured.length === 0 ? (
            <li className="px-[22px] py-[22px] text-center font-mono text-[13px] text-text-tertiary">
              No extraWorkflowSources in .archon/config.yaml.
            </li>
          ) : (
            configured.map(source => (
              <li
                key={`${source.ref}:${source.path}`}
                className="flex items-center justify-between gap-3 p-2 pl-3"
              >
                <span className="truncate font-mono text-[13px] text-text-primary">
                  {source.ref}
                  {source.path === '.' ? '' : `:${source.path}`}
                </span>
                <span className="shrink-0 font-mono text-[12px] text-text-tertiary">
                  {source.snapshot === null
                    ? 'not synced'
                    : `${shortCommit(source.snapshot.commit)}${
                        source.snapshot.fetched ? '' : ' (local)'
                      }`}
                </span>
              </li>
            ))
          )}
        </ul>
      )}

      {syncError !== null ? (
        <p role="alert" className="mb-3 break-words font-mono text-[11px] text-error">
          {syncError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border px-3 py-[7px] text-[13px] text-text-secondary transition-colors hover:bg-surface-hover"
          style={{ borderColor: 'var(--border)' }}
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => void sync()}
          disabled={syncing || configured.length === 0}
          className="brand-bar rounded-lg px-3.5 py-1.5 text-[12px] font-bold text-white transition-all hover:brightness-110 disabled:opacity-40"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    </>
  );
}
