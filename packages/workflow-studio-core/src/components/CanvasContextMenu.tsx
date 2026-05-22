import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useBuilderStore } from '../store/builder-store';
import { useUserLibraryStore } from '../store/user-library-store';
import { usePositionContext } from '../hooks/PositionContext';
import { extractSubgraph } from '../snippets/extractSubgraph';
import {
  AlignVerticalIcon,
  AlignHorizontalIcon,
  SpaceHeightIcon,
  SpacingWidthIcon,
} from './icons/AlignmentIcons';

export interface CanvasContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * PowerPoint-style alignment/distribution menu for multi-selected nodes.
 * Rendered absolutely-positioned within the Canvas container, so (x, y) are
 * client coords relative to the canvas viewport, not the page.
 */
export function CanvasContextMenu({ x, y, onClose }: CanvasContextMenuProps): JSX.Element {
  const selectedNodeIds = useBuilderStore(s => s.selectedNodeIds);
  const alignSelection = useBuilderStore(s => s.alignSelection);
  const distributeSelection = useBuilderStore(s => s.distributeSelection);
  const addUserSnippet = useUserLibraryStore(s => s.addUserSnippet);
  const positionCtx = usePositionContext();
  const ref = useRef<HTMLDivElement | null>(null);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [savePromptName, setSavePromptName] = useState('');

  const selectionCount = selectedNodeIds.length;
  const canAlign = selectionCount >= 2;
  const canDistribute = selectionCount >= 3;
  const canSaveSnippet = selectionCount >= 1;

  useEffect(() => {
    // Capture phase + window covers cases where React Flow stops propagation
    // of pointer events at the pane (which was making the menu stick around).
    // Attaching in useEffect is safe because the right-click sequence is
    // pointerdown → mouseup → contextmenu — all complete before useEffect
    // runs, so there's no orphan event to immediately re-close the menu.
    function handlePointerDown(e: PointerEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleContextMenu(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    // Pointer Events cover mouse, touch, and pen — registering both
    // pointerdown AND mousedown would fire the handler twice per click
    // (pointerdown precedes mousedown in the dispatch sequence).
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('keydown', handleKey, true);
    return (): void => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  function runAlign(direction: 'centerV' | 'centerH'): void {
    useBuilderStore.getState().setManyPositions(positionCtx.positions);
    alignSelection(direction);
    positionCtx.setMany(Object.entries(useBuilderStore.getState().positions));
    onClose();
  }

  function runDistribute(axis: 'h' | 'v'): void {
    useBuilderStore.getState().setManyPositions(positionCtx.positions);
    distributeSelection(axis);
    positionCtx.setMany(Object.entries(useBuilderStore.getState().positions));
    onClose();
  }

  function commitSaveSnippet(): void {
    const name = savePromptName.trim();
    if (!name) return;
    const { nodes, selectedNodeIds: ids } = useBuilderStore.getState();
    if (ids.length === 0) return;
    const { yaml } = extractSubgraph({
      nodes,
      selectedIds: ids,
      workflowName: name,
    });
    addUserSnippet({ name, yaml });
    setSavePromptOpen(false);
    setSavePromptName('');
    onClose();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Alignment menu"
      data-testid="canvas-context-menu"
      onContextMenu={e => {
        e.preventDefault();
      }}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        zIndex: 50,
        minWidth: 220,
        background: 'var(--studio-surface)',
        color: 'var(--studio-fg)',
        border: '1px solid var(--studio-muted)',
        borderRadius: 'var(--radius-sm, 4px)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        padding: '4px 0',
        userSelect: 'none',
      }}
    >
      <MenuItem
        icon={<AlignVerticalIcon width={16} height={16} />}
        label="Align vertically"
        hint="Centers along a vertical axis"
        disabled={!canAlign}
        onSelect={() => {
          runAlign('centerV');
        }}
      />
      <MenuItem
        icon={<AlignHorizontalIcon width={16} height={16} />}
        label="Align horizontally"
        hint="Centers along a horizontal axis"
        disabled={!canAlign}
        onSelect={() => {
          runAlign('centerH');
        }}
      />
      <Separator />
      <MenuItem
        icon={<SpacingWidthIcon width={16} height={16} />}
        label="Space evenly horizontally"
        hint="Equal gaps left-to-right (3+ nodes)"
        disabled={!canDistribute}
        onSelect={() => {
          runDistribute('h');
        }}
      />
      <MenuItem
        icon={<SpaceHeightIcon width={16} height={16} />}
        label="Space evenly vertically"
        hint="Equal gaps top-to-bottom (3+ nodes)"
        disabled={!canDistribute}
        onSelect={() => {
          runDistribute('v');
        }}
      />
      <Separator />
      {savePromptOpen ? (
        <form
          onSubmit={e => {
            e.preventDefault();
            commitSaveSnippet();
          }}
          style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <label style={{ fontSize: 11, color: 'var(--studio-muted)' }}>Snippet name</label>
          <input
            type="text"
            autoFocus
            value={savePromptName}
            onChange={e => {
              setSavePromptName(e.target.value);
            }}
            aria-label="Snippet name"
            style={{
              padding: '4px 8px',
              fontSize: 12,
              background: 'var(--studio-bg, #1c1c1c)',
              color: 'var(--studio-fg)',
              border: '1px solid var(--studio-muted)',
              borderRadius: 'var(--radius-sm, 4px)',
            }}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="submit"
              disabled={!savePromptName.trim()}
              style={{
                flex: 1,
                background: 'var(--studio-accent, #7c3aed)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm, 4px)',
                padding: '4px 8px',
                fontSize: 12,
                cursor: savePromptName.trim() ? 'pointer' : 'not-allowed',
                opacity: savePromptName.trim() ? 1 : 0.5,
              }}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setSavePromptOpen(false);
                setSavePromptName('');
              }}
              style={{
                flex: 1,
                background: 'transparent',
                color: 'var(--studio-fg)',
                border: '1px solid var(--studio-muted)',
                borderRadius: 'var(--radius-sm, 4px)',
                padding: '4px 8px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <MenuItem
          label="Save selection as snippet…"
          hint={
            canSaveSnippet
              ? 'Save the current selection to your snippets library'
              : 'Select at least one node first'
          }
          disabled={!canSaveSnippet}
          onSelect={() => {
            setSavePromptOpen(true);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      title={hint}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '6px 12px',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        font: 'inherit',
      }}
    >
      {icon ? (
        <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
          {icon}
        </span>
      ) : null}
      <span>{label}</span>
    </button>
  );
}

function Separator(): JSX.Element {
  return (
    <div
      role="separator"
      style={{
        height: 1,
        background: 'var(--studio-muted)',
        margin: '4px 0',
        opacity: 0.6,
      }}
    />
  );
}
