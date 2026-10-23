import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { formatProjectLocator } from '../lib/format';
import { HttpError, errorDetail } from '../lib/http';
import type { Project } from '../primitives/project';

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => Promise<void>;
  onRename?: (name: string) => Promise<void>;
  onEditEnv?: () => void;
}

function KeyIcon({ size = 16 }: { size?: number }): ReactElement {
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
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function DotsIcon({ size = 17 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function PencilIcon({ size = 15 }: { size?: number }): ReactElement {
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
      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function TrashIcon({ size = 15 }: { size?: number }): ReactElement {
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
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

/** Brand gradient strip when selected; while busy, the pending action's label instead. */
function RowStatusMarker({
  removing,
  renaming,
  selected,
}: {
  removing: boolean;
  renaming: boolean;
  selected: boolean;
}): ReactElement | null {
  if (removing) return <BusyLabel text="removing…" />;
  if (renaming) return <BusyLabel text="renaming…" />;
  if (!selected) return null;
  return (
    <span
      aria-hidden
      className="brand-bar pointer-events-none absolute -left-px bottom-[9px] top-[9px] w-[3px] rounded-r-[3px]"
    />
  );
}

function BusyLabel({ text }: { text: string }): ReactElement {
  return (
    <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-text-tertiary">
      {text}
    </span>
  );
}

/** Group headers already show the owner — strip it from the row label. */
function rowLabel(projectName: string): string {
  return projectName.includes('/') ? projectName.slice(projectName.indexOf('/') + 1) : projectName;
}

/** Monogram tile — gradient-filled when active. */
function MonogramTile({ label, selected }: { label: string; selected: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[13px] font-bold transition-colors ${
        selected
          ? 'brand-bar text-white'
          : 'border border-border bg-surface-elevated text-text-secondary group-hover:text-text-primary'
      }`}
    >
      {(label[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** The row title; double-click starts a rename when `onStartRename` is given. */
function RowLabel({
  label,
  selected,
  onStartRename,
}: {
  label: string;
  selected: boolean;
  onStartRename?: () => void;
}): ReactElement {
  return (
    <span
      onDoubleClick={e => {
        if (onStartRename === undefined) return;
        e.stopPropagation();
        onStartRename();
      }}
      className={`truncate text-[13px] font-semibold tracking-[-0.1px] ${
        selected ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
      }`}
    >
      {label}
    </span>
  );
}

interface RenameInputProps {
  inputRef: RefObject<HTMLInputElement | null>;
  draft: string;
  onDraftChange: (draft: string) => void;
  onCancel: () => void;
  onFinish: () => void;
}

/**
 * Enter and Escape both blur, so the rename has exactly one commit path
 * (`onFinish` on blur); Escape first marks the edit cancelled.
 */
function RenameInput({
  inputRef,
  draft,
  onDraftChange,
  onCancel,
  onFinish,
}: RenameInputProps): ReactElement {
  return (
    <input
      ref={inputRef}
      value={draft}
      autoFocus
      onChange={e => {
        onDraftChange(e.target.value);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
      onBlur={onFinish}
      onClick={e => {
        e.stopPropagation();
      }}
      onDoubleClick={e => {
        e.stopPropagation();
      }}
      className="w-full rounded border border-border-bright bg-surface px-1 py-0.5 text-[13px] font-medium text-text-primary focus:outline-none"
    />
  );
}

function LivePulse(): ReactElement {
  return (
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
  );
}

interface RowActionsProps {
  projectName: string;
  selected: boolean;
  hasMenu: boolean;
  menuOpen: boolean;
  busy: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  onEditEnv?: () => void;
  onStartRename?: () => void;
  onRemove?: () => void;
}

/** Hover actions: env vars + ⋯ menu. */
function RowActions({
  projectName,
  selected,
  hasMenu,
  menuOpen,
  busy,
  setMenuOpen,
  onEditEnv,
  onStartRename,
  onRemove,
}: RowActionsProps): ReactElement {
  return (
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
          className="flex h-[29px] w-[29px] items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <KeyIcon />
        </button>
      ) : null}
      {hasMenu ? (
        <div className="relative">
          <button
            type="button"
            disabled={busy}
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(v => !v);
            }}
            title="More actions"
            aria-label="More actions"
            aria-expanded={menuOpen}
            className={`flex h-[29px] w-[29px] items-center justify-center rounded-lg transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50 ${
              menuOpen ? 'bg-surface-hover text-text-primary' : 'text-text-tertiary'
            }`}
          >
            <DotsIcon />
          </button>
          {menuOpen ? (
            <RowMenu
              projectName={projectName}
              onClose={() => {
                setMenuOpen(false);
              }}
              onStartRename={onStartRename}
              onRemove={onRemove}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowMenu({
  projectName,
  onClose,
  onStartRename,
  onRemove,
}: {
  projectName: string;
  onClose: () => void;
  onStartRename?: () => void;
  onRemove?: () => void;
}): ReactElement {
  return (
    <div
      role="menu"
      onClick={e => {
        e.stopPropagation();
      }}
      className="absolute right-0 top-full z-30 mt-1 min-w-[178px] rounded-[11px] border bg-surface-hover p-[5px] shadow-[0_18px_44px_-18px_rgba(0,0,0,0.85)]"
      // Inline because the console scope's wildcard border-color
      // rule repaints Tailwind border utilities (see theme.css).
      style={{ borderColor: 'var(--border-bright)' }}
    >
      {onStartRename !== undefined ? (
        <button
          type="button"
          role="menuitem"
          onClick={e => {
            e.stopPropagation();
            onClose();
            onStartRename();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-[11px] py-[9px] text-left text-[13px] font-semibold text-text-primary transition-colors hover:bg-surface-elevated"
        >
          <PencilIcon />
          Rename project
        </button>
      ) : null}
      {onRemove !== undefined ? (
        <button
          type="button"
          role="menuitem"
          onClick={e => {
            e.stopPropagation();
            onClose();
            const confirmed = window.confirm(
              `Remove project "${projectName}"?\n\nLocal files and worktrees are not deleted.`
            );
            if (confirmed) onRemove();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-[11px] py-[9px] text-left text-[13px] font-semibold text-error transition-colors hover:bg-error/10"
        >
          <TrashIcon />
          Remove project
        </button>
      ) : null}
    </div>
  );
}

/** A failed action's message inside the row; its clicks and keys stay off the row. */
function RowAlert({
  message,
  children,
}: {
  message: string | null;
  children: ReactNode;
}): ReactElement | null {
  if (message === null) return null;
  return (
    <div
      role="alert"
      onClick={event => {
        event.stopPropagation();
      }}
      onKeyDown={event => {
        event.stopPropagation();
      }}
      className="basis-full rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[10px] text-error [overflow-wrap:anywhere]"
    >
      <p>{message}</p>
      {children}
    </div>
  );
}

/**
 * Rail row, design v2: monogram tile + repo-only title (the owner lives in
 * the group header above) + locator path + hover actions. Selection is the
 * gradient strip, gradient monogram, elevated background, and a LIVE pulse.
 * Double-click the title (or use the ⋯ menu) to rename the project on the
 * server; the path stays as a stable subtitle.
 */
export function ProjectRow({
  project,
  selected,
  onClick,
  onRemove,
  onRename,
  onEditEnv,
}: ProjectRowProps): ReactElement {
  const label = rowLabel(project.name);
  const hasMenu = onRemove !== undefined || onRename !== undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set by Escape so the blur that ends editing discards the draft.
  const cancelEditRef = useRef(false);
  const busy = removing || renaming;
  const startRename =
    onRename === undefined
      ? undefined
      : (): void => {
          setEditing(true);
        };

  useEffect(() => {
    if (editing) {
      setDraft(project.name);
      inputRef.current?.select();
    }
  }, [editing, project.name]);

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

  const finishEditing = async (): Promise<void> => {
    const cancelled = cancelEditRef.current;
    cancelEditRef.current = false;
    setEditing(false);
    const name = draft.trim();
    if (cancelled || onRename === undefined || name === '' || name === project.name) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await onRename(name);
    } catch (renameFailure: unknown) {
      // serverError carries the full refusal; errorDetail only sees a capped snippet.
      setRenameError(
        renameFailure instanceof HttpError && renameFailure.serverError !== undefined
          ? renameFailure.serverError
          : errorDetail(renameFailure)
      );
    } finally {
      setRenaming(false);
    }
  };

  const requestRemoval = async (): Promise<void> => {
    if (onRemove === undefined || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemove();
    } catch (removeFailure: unknown) {
      setRemoveError(
        removeFailure instanceof Error ? removeFailure.message : 'Could not remove project.'
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div
      onClick={editing || menuOpen ? undefined : onClick}
      onContextMenu={e => {
        if (!hasMenu || editing || busy) return;
        e.preventDefault();
        setMenuOpen(true);
      }}
      role="button"
      tabIndex={editing ? -1 : 0}
      onKeyDown={e => {
        if (editing || e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-busy={busy}
      aria-pressed={selected}
      title={onRename === undefined ? project.name : `${project.name} · double-click to rename`}
      className={`group relative flex w-full cursor-pointer flex-wrap items-center gap-x-[11px] gap-y-2 rounded-[10px] border px-2.5 py-2 text-left transition-colors ${
        selected ? 'bg-surface-elevated' : 'bg-transparent hover:bg-surface-hover'
      }`}
      // Inline because the console scope's wildcard `border-color: var(--border)`
      // rule repaints Tailwind border-color utilities (see theme.css).
      style={{ borderColor: selected ? 'var(--border-bright)' : 'transparent' }}
    >
      <RowStatusMarker removing={removing} renaming={renaming} selected={selected} />

      <MonogramTile label={label} selected={selected} />

      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        {editing ? (
          <RenameInput
            inputRef={inputRef}
            draft={draft}
            onDraftChange={setDraft}
            onCancel={() => {
              cancelEditRef.current = true;
            }}
            onFinish={() => void finishEditing()}
          />
        ) : (
          <RowLabel
            label={label}
            selected={selected}
            onStartRename={busy ? undefined : startRename}
          />
        )}
        <span className="truncate font-mono text-[10.5px] text-text-tertiary">
          {formatProjectLocator(project)}
        </span>
      </div>

      {/* LIVE pulse on the selected project — hidden while hovering so the
          env/⋯ actions can take its slot. */}
      {selected ? <LivePulse /> : null}

      <RowActions
        projectName={project.name}
        selected={selected}
        hasMenu={hasMenu}
        menuOpen={menuOpen}
        busy={busy}
        setMenuOpen={setMenuOpen}
        onEditEnv={onEditEnv}
        onStartRename={startRename}
        onRemove={onRemove === undefined ? undefined : () => void requestRemoval()}
      />
      <RowAlert message={removeError}>
        <button
          type="button"
          onClick={() => void requestRemoval()}
          disabled={removing}
          className="mt-1 font-semibold underline underline-offset-2 disabled:cursor-wait disabled:opacity-50"
        >
          Retry removal
        </button>
      </RowAlert>
      <RowAlert message={renameError}>
        <button
          type="button"
          onClick={() => {
            setRenameError(null);
          }}
          className="mt-1 font-semibold underline underline-offset-2"
        >
          Dismiss
        </button>
      </RowAlert>
    </div>
  );
}
