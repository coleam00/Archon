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
 * Rail row, design v2: monogram tile + repo-only title (the owner lives in
 * the group header above) + locator path + hover actions. Selection is the
 * gradient strip, gradient monogram, elevated background, and a LIVE pulse.
 * Double-click the title to rename; the path stays as a stable subtitle.
 */
export function ProjectRow({
  project,
  selected,
  onClick,
  onRemove,
  onEditEnv,
}: ProjectRowProps): ReactElement {
  const displayName = useDisplayName(project.id, project.name);
  // Group headers already show the owner — strip it from the row label
  // unless the user renamed the project (then show their name verbatim).
  const label =
    displayName === project.name && project.name.includes('/')
      ? project.name.slice(project.name.indexOf('/') + 1)
      : displayName;
  const monogram = (label[0] ?? '?').toUpperCase();
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
      className={`group relative flex w-full cursor-pointer items-center gap-[11px] rounded-[10px] border px-2.5 py-2 text-left transition-colors ${
        selected ? 'bg-surface-elevated' : 'bg-transparent hover:bg-surface-hover'
      }`}
      // Inline because the console scope's wildcard `border-color: var(--border)`
      // rule repaints Tailwind border-color utilities (see theme.css).
      style={{ borderColor: selected ? 'var(--border-bright)' : 'transparent' }}
    >
      {/* Brand gradient strip — the unmistakable "this is selected" cue. */}
      {selected ? (
        <span
          aria-hidden
          className="brand-bar pointer-events-none absolute -left-px bottom-[9px] top-[9px] w-[3px] rounded-r-[3px]"
        />
      ) : null}

      {/* Monogram tile — gradient-filled when active */}
      <span
        aria-hidden
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[13px] font-bold transition-colors ${
          selected
            ? 'brand-bar text-white'
            : 'border border-border bg-surface-elevated text-text-secondary group-hover:text-text-primary'
        }`}
      >
        {monogram}
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
            className={`truncate text-[13px] font-semibold tracking-[-0.1px] ${
              selected ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
            }`}
          >
            {label}
          </span>
        )}
        <span className="truncate font-mono text-[10.5px] text-text-tertiary">
          {formatProjectLocator(project)}
        </span>
      </div>

      {/* LIVE pulse on the selected project — hidden while hovering so the
          env/⋯ actions can take its slot. */}
      {selected ? (
        <span
          title="Active project"
          className="inline-flex shrink-0 items-center gap-[5px] font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-success group-hover:hidden"
        >
          <i
            aria-hidden
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success),transparent_82%)]"
          />
          live
        </span>
      ) : null}

      {/* Hover actions: env vars + ⋯ menu. */}
      <div
        className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
          selected
            ? menuOpen
              ? 'flex'
              : 'hidden group-hover:flex'
            : 'opacity-0 group-hover:opacity-100'
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
