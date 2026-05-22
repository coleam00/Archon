import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useDisplayName, setDisplayName } from '../lib/display-name';
import { formatProjectLocator } from '../lib/format';
import type { Project } from '../primitives/project';

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
  onEditEnv?: () => void;
}

/**
 * Rail row: title + locator (path) + hover actions. No avatar (the first
 * letter of `owner/repo` carried no information), no status indicator
 * (red-because-some-old-run-failed was noise, not signal). Selection is
 * the gradient strip + elevated background. Double-click the title to
 * rename; the path stays as a stable subtitle.
 */
export function ProjectRow({
  project,
  selected,
  onClick,
  onRemove,
  onEditEnv,
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
    </div>
  );
}
