import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useBuilderStore } from '../store/builder-store';
import { useUndoStore } from '../store/undo-store';
import { usePositionContext } from '../hooks/PositionContext';
import {
  AlignVerticalIcon,
  AlignHorizontalIcon,
  SpaceHeightIcon,
  SpacingWidthIcon,
} from './icons/AlignmentIcons';

export interface ToolbarProps {
  workflowName: string;
  onResetLayout: () => void;
  /** When provided, renders a Save button in the toolbar. */
  onSave?: () => void;
  /** When true, the Save button is disabled (there are validation errors). */
  hasErrors?: boolean;
  /** Up to 3 error messages shown in the Save button's title tooltip. */
  topErrors?: readonly string[];
  /** When true, the YAML toggle button renders pressed. */
  isYamlPreviewOpen?: boolean;
  /** When provided, renders the YAML toggle button. */
  onToggleYamlPreview?: () => void;
  /** When provided, renders a "Validate" button that calls this callback. */
  onValidate?: () => void;
  /** When true, the Validate button shows a loading state and is disabled. */
  isValidating?: boolean;
  /** When provided, renders a "Share to Marketplace" link that opens in a new tab. */
  marketplaceUrl?: string;
  /**
   * When provided, the workflow name renders as an inline-editable input.
   * Called on blur or Enter with the trimmed new name. The host is responsible
   * for seeding the workflow meta if it does not yet exist.
   */
  onWorkflowNameChange?: (name: string) => void;
}

const buttonBase: CSSProperties = {
  background: 'transparent',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-muted)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
};

interface ToolButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  title?: string;
}

function ToolButton({
  label,
  onClick,
  children,
  disabled,
  pressed,
  title,
}: ToolButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...buttonBase,
        background: pressed ? 'var(--studio-accent, #7c3aed)' : 'transparent',
        color: pressed ? '#fff' : 'var(--studio-fg)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Inline select/pan-mode icons. The dashed rectangle conveys "selection box"
// and the hand conveys "drag-to-pan" — these mirror React Flow's two
// canvas interaction modes (canvasMode in builder-store).
function SelectModeIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeDasharray="3 2"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function PanModeIcon(): JSX.Element {
  return (
    <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
      ✋
    </span>
  );
}

export function Toolbar({
  workflowName,
  onResetLayout,
  onSave,
  hasErrors,
  topErrors = [],
  isYamlPreviewOpen,
  onToggleYamlPreview,
  onValidate,
  isValidating,
  marketplaceUrl,
  onWorkflowNameChange,
}: ToolbarProps): JSX.Element {
  const selectedNodeIds = useBuilderStore(s => s.selectedNodeIds);
  const alignSelection = useBuilderStore(s => s.alignSelection);
  const distributeSelection = useBuilderStore(s => s.distributeSelection);
  const autoArrangeSelection = useBuilderStore(s => s.autoArrangeSelection);
  const gridSnap = useBuilderStore(s => s.gridSnap);
  const toggleGridSnap = useBuilderStore(s => s.toggleGridSnap);
  const canvasMode = useBuilderStore(s => s.canvasMode);
  const setCanvasMode = useBuilderStore(s => s.setCanvasMode);
  const applyUndo = useBuilderStore(s => s.applyUndo);
  const applyRedo = useBuilderStore(s => s.applyRedo);
  const undoLabel = useUndoStore(s => s.nextUndoLabel());
  const redoLabel = useUndoStore(s => s.nextRedoLabel());
  const hasSelection = selectedNodeIds.length >= 2;
  const canDistribute = selectedNodeIds.length >= 3;
  const positionCtx = usePositionContext();

  function syncBefore(): void {
    useBuilderStore.getState().setManyPositions(positionCtx.positions);
  }

  function syncAfter(): void {
    positionCtx.setMany(Object.entries(useBuilderStore.getState().positions));
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        background: 'var(--studio-surface)',
        borderBottom: '1px solid var(--studio-muted)',
      }}
    >
      {onWorkflowNameChange ? (
        <WorkflowNameField name={workflowName} onChange={onWorkflowNameChange} />
      ) : (
        <strong style={{ flex: 1 }}>{workflowName}</strong>
      )}

      <ToolButton
        label={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
        disabled={!undoLabel}
        onClick={() => {
          applyUndo();
          syncAfter();
        }}
      >
        ↶
      </ToolButton>

      <ToolButton
        label={redoLabel ? `Redo: ${redoLabel}` : 'Redo'}
        disabled={!redoLabel}
        onClick={() => {
          applyRedo();
          syncAfter();
        }}
      >
        ↷
      </ToolButton>

      <ToolButton label="Reset layout" onClick={onResetLayout}>
        Reset layout
      </ToolButton>

      <ToolButton
        label="Select mode"
        pressed={canvasMode === 'select'}
        onClick={() => {
          setCanvasMode('select');
        }}
      >
        <SelectModeIcon />
      </ToolButton>

      <ToolButton
        label="Pan mode"
        pressed={canvasMode === 'pan'}
        onClick={() => {
          setCanvasMode('pan');
        }}
      >
        <PanModeIcon />
      </ToolButton>

      <div role="group" aria-label="Alignment" style={{ display: 'flex', gap: 8 }}>
        <ToolButton
          label="Align horizontal centers"
          disabled={!hasSelection}
          onClick={() => {
            syncBefore();
            alignSelection('centerH');
            syncAfter();
          }}
        >
          <AlignVerticalIcon />
        </ToolButton>
        <ToolButton
          label="Align vertical centers"
          disabled={!hasSelection}
          onClick={() => {
            syncBefore();
            alignSelection('centerV');
            syncAfter();
          }}
        >
          <AlignHorizontalIcon />
        </ToolButton>
        <ToolButton
          label="Distribute horizontally"
          disabled={!canDistribute}
          onClick={() => {
            syncBefore();
            distributeSelection('h');
            syncAfter();
          }}
        >
          <SpacingWidthIcon />
        </ToolButton>
        <ToolButton
          label="Distribute vertically"
          disabled={!canDistribute}
          onClick={() => {
            syncBefore();
            distributeSelection('v');
            syncAfter();
          }}
        >
          <SpaceHeightIcon />
        </ToolButton>
        <ToolButton
          label="Auto arrange"
          disabled={!hasSelection}
          onClick={() => {
            syncBefore();
            autoArrangeSelection();
            syncAfter();
          }}
        >
          ⊞
        </ToolButton>
      </div>

      {onToggleYamlPreview ? (
        <ToolButton
          label="Toggle YAML preview"
          pressed={!!isYamlPreviewOpen}
          onClick={onToggleYamlPreview}
        >
          YAML
        </ToolButton>
      ) : null}

      {onValidate ? (
        <ToolButton
          label={isValidating ? 'Validating' : 'Validate'}
          disabled={!!isValidating}
          title={isValidating ? 'Validating…' : 'Re-run validation now'}
          onClick={onValidate}
        >
          {isValidating ? 'Validating…' : 'Validate'}
        </ToolButton>
      ) : null}

      <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={gridSnap}
          onChange={toggleGridSnap}
          aria-label="Snap to grid"
        />
        Grid
      </label>

      {onSave ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {hasErrors && topErrors.length > 0 ? (
            // Inline reason next to the disabled Save button. Without this the
            // user has no obvious link between Save being greyed out and the
            // validation panel at the bottom of the canvas; the title-tooltip
            // alone is too easy to miss. We show the first error verbatim plus
            // a "+N more" suffix when there are additional issues.
            <span
              role="status"
              title={topErrors.slice(0, 3).join('\n')}
              style={{
                fontSize: 12,
                color: 'var(--studio-error, #ef4444)',
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Cannot save: {topErrors[0]}
              {topErrors.length > 1 ? ` (+${String(topErrors.length - 1)} more)` : ''}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onSave}
            disabled={!!hasErrors}
            title={hasErrors ? topErrors.slice(0, 3).join('\n') : undefined}
            style={{
              background: 'var(--studio-accent, #7c3aed)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 12px',
              cursor: hasErrors ? 'not-allowed' : 'pointer',
              opacity: hasErrors ? 0.6 : 1,
            }}
          >
            Save
          </button>
        </div>
      ) : null}

      {marketplaceUrl ? (
        <a
          href={marketplaceUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Share this workflow to the Archon Marketplace (opens GitHub)"
          style={{
            color: 'var(--studio-fg)',
            border: '1px solid var(--studio-muted)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          Share ↗
        </a>
      ) : null}
    </header>
  );
}

function WorkflowNameField({
  name,
  onChange,
}: {
  name: string;
  onChange: (name: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = (): void => {
    const next = draft.trim();
    if (next === name || next === '') {
      setDraft(name);
      return;
    }
    onChange(next);
  };

  return (
    <input
      aria-label="Workflow name"
      value={draft}
      placeholder="workflow name"
      onChange={e => {
        setDraft(e.target.value);
      }}
      onBlur={e => {
        commit();
        e.currentTarget.style.borderColor = 'transparent';
        e.currentTarget.style.background = 'transparent';
      }}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'var(--studio-muted)';
        e.currentTarget.style.background = 'var(--studio-bg-elevated)';
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        flex: 1,
        background: 'transparent',
        color: 'var(--studio-fg)',
        border: '1px solid transparent',
        borderRadius: 'var(--radius-sm)',
        padding: '4px 6px',
        font: 'inherit',
        fontWeight: 600,
        outline: 'none',
      }}
    />
  );
}
