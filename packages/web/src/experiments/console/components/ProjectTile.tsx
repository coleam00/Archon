import type { CSSProperties, ReactElement } from 'react';
import { tileAbbreviation, tileColor } from '../lib/icon-color';

interface ProjectTileProps {
  projectId: string;
  name: string;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
  activityDot?: 'running' | 'paused' | 'failed' | null;
}

/**
 * 44×44 rounded square with a 2-letter abbreviation on a deterministic
 * background color. Rail peer of {@link RailSlot}; both share the same
 * aspect-square geometry so the column reads as a clean grid.
 */
export function ProjectTile({
  projectId,
  name,
  selected,
  onClick,
  onRemove,
  activityDot = null,
}: ProjectTileProps): ReactElement {
  const style: CSSProperties = { backgroundColor: tileColor(projectId) };
  const ring = selected
    ? 'ring-2 ring-accent-bright ring-offset-[3px] ring-offset-surface-inset'
    : 'ring-0';

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={e => {
        if (onRemove === undefined) return;
        e.preventDefault();
        const confirmed = window.confirm(
          `Remove project "${name}"?\n\nLocal files and worktrees are not deleted.`
        );
        if (confirmed) onRemove();
      }}
      title={`${name} · right-click to remove`}
      aria-label={name}
      aria-pressed={selected}
      className={`relative aspect-square w-11 rounded-md flex items-center justify-center text-[13px] font-semibold leading-none text-white/95 transition-[transform,box-shadow] hover:-translate-y-[1px] active:translate-y-0 ${ring}`}
      style={style}
    >
      <span className="pointer-events-none select-none tracking-tight">
        {tileAbbreviation(name)}
      </span>
      {activityDot !== null ? (
        <span
          aria-hidden="true"
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface-inset ${
            activityDot === 'running'
              ? 'bg-[color:var(--running)]'
              : activityDot === 'paused'
                ? 'bg-warning animate-pulse'
                : 'bg-error'
          }`}
        />
      ) : null}
    </button>
  );
}
