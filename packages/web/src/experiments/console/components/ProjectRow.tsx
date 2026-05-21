import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { tileColor } from '../lib/icon-color';
import { useDisplayName, setDisplayName } from '../lib/display-name';
import { formatProjectLocator } from '../lib/format';
import type { Project } from '../primitives/project';

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
  onEditEnv?: () => void;
  activityDot?: 'running' | 'paused' | 'failed' | null;
}

/**
 * Wide rail row: colored dot · two lines (title + locator). Title is the
 * project's API name unless the user has set an override via double-click.
 * Right-click opens the remove confirmation (same UX as the previous tile).
 */
export function ProjectRow({
  project,
  selected,
  onClick,
  onRemove,
  onEditEnv,
  activityDot = null,
}: ProjectRowProps): ReactElement {
  const displayName = useDisplayName(project.id, project.name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(displayName);
      inputRef.current?.select();
    }
  }, [editing, displayName]);

  const commit = (): void => {
    if (draft.trim() === project.name) setDisplayName(project.id, '');
    else setDisplayName(project.id, draft);
    setEditing(false);
  };
  const cancel = (): void => {
    setEditing(false);
  };

  const dotStyle: CSSProperties = { backgroundColor: tileColor(project.id) };
  const ring = selected
    ? 'ring-2 ring-accent-bright ring-offset-2 ring-offset-surface-inset'
    : 'ring-0';
  const bg = selected ? 'bg-surface-elevated' : 'bg-transparent hover:bg-surface-hover';

  return (
    <div
      onClick={editing ? undefined : onClick}
      onContextMenu={e => {
        if (onRemove === undefined || editing) return;
        e.preventDefault();
        const confirmed = window.confirm(
          `Remove project "${displayName}"?\n\nLocal files and worktrees are not deleted.`
        );
        if (confirmed) onRemove();
      }}
      role="button"
      tabIndex={editing ? -1 : 0}
      onKeyDown={e => {
        if (editing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-pressed={selected}
      title={`${displayName} · double-click to rename · right-click to remove`}
      className={`group relative flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${bg} ${ring}`}
    >
      <span
        aria-hidden="true"
        style={dotStyle}
        className="mt-1 h-2 w-2 shrink-0 self-start rounded-full"
      />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            autoFocus
            onChange={e => {
              setDraft(e.target.value);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
              e.stopPropagation();
            }}
            onBlur={commit}
            onClick={e => {
              e.stopPropagation();
            }}
            onDoubleClick={e => {
              e.stopPropagation();
            }}
            className="w-full rounded border border-border-bright bg-surface px-1 py-0.5 text-[13px] font-medium text-text-primary focus:outline-none"
          />
        ) : (
          <span
            onDoubleClick={e => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="truncate text-[13px] font-medium text-text-primary"
          >
            {displayName}
          </span>
        )}
        <span className="truncate font-mono text-[10.5px] text-text-tertiary">
          {formatProjectLocator(project)}
        </span>
      </div>
      {onEditEnv !== undefined && (selected || activityDot === null) ? (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onEditEnv();
          }}
          title="Environment variables"
          aria-label="Environment variables"
          className={`shrink-0 rounded p-1 font-mono text-[11px] leading-none transition-opacity ${
            selected
              ? 'text-text-tertiary opacity-70 hover:bg-surface-hover hover:text-text-primary hover:opacity-100'
              : 'text-text-tertiary opacity-0 group-hover:opacity-70 group-hover:hover:bg-surface-hover group-hover:hover:opacity-100'
          }`}
        >
          ⚙
        </button>
      ) : null}
      {activityDot !== null ? (
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${
            activityDot === 'running'
              ? 'bg-[color:var(--running)]'
              : activityDot === 'paused'
                ? 'bg-warning animate-pulse'
                : 'bg-error'
          }`}
        />
      ) : null}
    </div>
  );
}
