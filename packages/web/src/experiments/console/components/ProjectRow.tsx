import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { tileColor } from '../lib/icon-color';
import { useDisplayName, setDisplayName } from '../lib/display-name';
import { formatProjectLocator } from '../lib/format';
import type { Project } from '../primitives/project';

export type ActivityDot = 'running' | 'paused' | 'failed';

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
  onEditEnv?: () => void;
  activityDot?: ActivityDot | null;
}

/**
 * Rail row: avatar · two lines (title + locator) · hover-actions · status.
 *
 * Avatar is the first letter of the project name on a hash-derived
 * background — scannable identity that can never be confused with the
 * activity status dot on the right. Double-click the title to rename;
 * the override is local-only and the path stays put as the subtitle.
 *
 * `activityDot` is what the right-side pulse is. It only renders when
 * the project has running / paused / failed runs; idle projects have
 * nothing on the right.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(displayName);
      inputRef.current?.select();
    }
  }, [editing, displayName]);

  // Close the ⋯ menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (): void => {
      setMenuOpen(false);
    };
    window.addEventListener('click', close);
    return (): void => {
      window.removeEventListener('click', close);
    };
  }, [menuOpen]);

  const commit = (): void => {
    if (draft.trim() === project.name) setDisplayName(project.id, '');
    else setDisplayName(project.id, draft);
    setEditing(false);
  };
  const cancel = (): void => {
    setEditing(false);
  };

  const avatarChar =
    displayName
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 1)
      .toUpperCase() || '·';
  const avatarStyle: CSSProperties = {
    backgroundColor: tileColor(project.id),
  };

  return (
    <div
      onClick={editing || menuOpen ? undefined : onClick}
      onContextMenu={e => {
        if (onRemove === undefined || editing) return;
        e.preventDefault();
        setMenuOpen(true);
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
      title={`${displayName} · double-click to rename`}
      className={`group relative flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        selected ? 'bg-surface-elevated' : 'bg-transparent hover:bg-surface-hover'
      }`}
    >
      {/* Brand gradient strip — the unmistakable "this is selected" cue.
          rounded-l matches the row's own corner radius so the strip blends
          into the corners (no overflow-hidden needed; that would clip the
          ⋯ dropdown menu below). */}
      {selected ? (
        <span
          aria-hidden
          className="brand-bar pointer-events-none absolute left-0 top-0 bottom-0 w-1 rounded-l-md"
        />
      ) : null}

      {/* Identity avatar — initial on a hash-coloured square. */}
      <span
        aria-hidden="true"
        style={avatarStyle}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white/95"
      >
        {avatarChar}
      </span>

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
            className={`truncate text-[13px] font-medium ${
              selected ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
            }`}
          >
            {displayName}
          </span>
        )}
        <span className="truncate font-mono text-[10.5px] text-text-tertiary">
          {formatProjectLocator(project)}
        </span>
      </div>

      {/* Hover actions: env vars + ⋯ menu. Always-visible on selected row
          so power features (env, remove) are one click away in the active
          context. */}
      <div
        className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        {onEditEnv !== undefined ? (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onEditEnv();
            }}
            title="Environment variables"
            aria-label="Environment variables"
            className="rounded p-1 font-mono text-[11px] leading-none text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            ⚙
          </button>
        ) : null}
        {onRemove !== undefined ? (
          <div className="relative">
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                setMenuOpen(v => !v);
              }}
              title="More actions"
              aria-label="More actions"
              aria-expanded={menuOpen}
              className="rounded p-1 font-mono text-[11px] leading-none text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              ⋯
            </button>
            {menuOpen ? (
              <div
                role="menu"
                onClick={e => {
                  e.stopPropagation();
                }}
                className="absolute right-0 top-full z-10 mt-1 min-w-[160px] rounded-md border border-border bg-surface-elevated p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={e => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    const confirmed = window.confirm(
                      `Remove project "${displayName}"?\n\nLocal files and worktrees are not deleted.`
                    );
                    if (confirmed) onRemove();
                  }}
                  className="block w-full rounded px-2 py-1 text-left text-[12px] text-error transition-colors hover:bg-error/10"
                >
                  Remove project
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Real activity indicator — only shown when the project actually has
          something in flight. Idle projects = no dot. */}
      {activityDot !== null ? (
        <span
          aria-hidden="true"
          title={
            activityDot === 'running'
              ? 'Running'
              : activityDot === 'paused'
                ? 'Waiting for approval'
                : 'Last run failed'
          }
          className={`h-2 w-2 shrink-0 rounded-full ${
            activityDot === 'running'
              ? 'animate-pulse bg-[color:var(--running)]'
              : activityDot === 'paused'
                ? 'animate-pulse bg-warning'
                : 'bg-error'
          }`}
        />
      ) : null}
    </div>
  );
}
