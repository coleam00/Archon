import { ThemePicker } from './ThemePicker';
import { useBuilderStore } from '../store/builder-store';
import { useUndoStore } from '../store/undo-store';
import { usePositionContext } from '../hooks/PositionContext';

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
  /** When false, hides the theme picker. Defaults to true. */
  showThemePicker?: boolean;
}

export function Toolbar({
  workflowName,
  onResetLayout,
  onSave,
  hasErrors,
  topErrors = [],
  isYamlPreviewOpen,
  onToggleYamlPreview,
  showThemePicker = true,
}: ToolbarProps): JSX.Element {
  const selectedNodeIds = useBuilderStore(s => s.selectedNodeIds);
  const alignSelection = useBuilderStore(s => s.alignSelection);
  const distributeSelection = useBuilderStore(s => s.distributeSelection);
  const autoArrangeSelection = useBuilderStore(s => s.autoArrangeSelection);
  const gridSnap = useBuilderStore(s => s.gridSnap);
  const toggleGridSnap = useBuilderStore(s => s.toggleGridSnap);
  const applyUndo = useBuilderStore(s => s.applyUndo);
  const applyRedo = useBuilderStore(s => s.applyRedo);
  const undoLabel = useUndoStore(s => s.nextUndoLabel());
  const redoLabel = useUndoStore(s => s.nextRedoLabel());
  const hasSelection = selectedNodeIds.length >= 2;
  const positionCtx = usePositionContext();

  function syncPositionsBeforeOp(): void {
    useBuilderStore.getState().setManyPositions(positionCtx.positions);
  }

  function syncPositionsAfterOp(): void {
    positionCtx.setMany(Object.entries(useBuilderStore.getState().positions));
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        background: 'var(--studio-surface)',
        borderBottom: '1px solid var(--studio-muted)',
      }}
    >
      <strong style={{ flex: 1 }}>{workflowName}</strong>
      <button
        type="button"
        aria-label={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
        title={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
        disabled={!undoLabel}
        onClick={() => {
          applyUndo();
          syncPositionsAfterOp();
        }}
        style={{
          background: 'transparent',
          color: 'var(--studio-fg)',
          border: '1px solid var(--studio-muted)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          cursor: undoLabel ? 'pointer' : 'not-allowed',
        }}
      >
        ↶
      </button>
      <button
        type="button"
        aria-label={redoLabel ? `Redo: ${redoLabel}` : 'Redo'}
        title={redoLabel ? `Redo: ${redoLabel}` : 'Redo'}
        disabled={!redoLabel}
        onClick={() => {
          applyRedo();
          syncPositionsAfterOp();
        }}
        style={{
          background: 'transparent',
          color: 'var(--studio-fg)',
          border: '1px solid var(--studio-muted)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          cursor: redoLabel ? 'pointer' : 'not-allowed',
        }}
      >
        ↷
      </button>
      <button
        type="button"
        onClick={onResetLayout}
        style={{
          background: 'transparent',
          color: 'var(--studio-fg)',
          border: '1px solid var(--studio-muted)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          cursor: 'pointer',
        }}
      >
        Reset layout
      </button>
      {hasSelection && (
        <div role="group" aria-label="Alignment">
          <button
            type="button"
            aria-label="Align left"
            onClick={() => {
              syncPositionsBeforeOp();
              alignSelection('left');
              syncPositionsAfterOp();
            }}
            style={{
              background: 'transparent',
              color: 'var(--studio-fg)',
              border: '1px solid var(--studio-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            ⬤←
          </button>
          <button
            type="button"
            aria-label="Align right"
            onClick={() => {
              syncPositionsBeforeOp();
              alignSelection('right');
              syncPositionsAfterOp();
            }}
            style={{
              background: 'transparent',
              color: 'var(--studio-fg)',
              border: '1px solid var(--studio-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            →⬤
          </button>
          <button
            type="button"
            aria-label="Align top"
            onClick={() => {
              syncPositionsBeforeOp();
              alignSelection('top');
              syncPositionsAfterOp();
            }}
            style={{
              background: 'transparent',
              color: 'var(--studio-fg)',
              border: '1px solid var(--studio-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            ⬤↑
          </button>
          <button
            type="button"
            aria-label="Align bottom"
            onClick={() => {
              syncPositionsBeforeOp();
              alignSelection('bottom');
              syncPositionsAfterOp();
            }}
            style={{
              background: 'transparent',
              color: 'var(--studio-fg)',
              border: '1px solid var(--studio-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            ↓⬤
          </button>
          {selectedNodeIds.length >= 3 && (
            <>
              <button
                type="button"
                aria-label="Distribute horizontally"
                onClick={() => {
                  syncPositionsBeforeOp();
                  distributeSelection('h');
                  syncPositionsAfterOp();
                }}
                style={{
                  background: 'transparent',
                  color: 'var(--studio-fg)',
                  border: '1px solid var(--studio-muted)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                ⇔
              </button>
              <button
                type="button"
                aria-label="Distribute vertically"
                onClick={() => {
                  syncPositionsBeforeOp();
                  distributeSelection('v');
                  syncPositionsAfterOp();
                }}
                style={{
                  background: 'transparent',
                  color: 'var(--studio-fg)',
                  border: '1px solid var(--studio-muted)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                ⇕
              </button>
            </>
          )}
          <button
            type="button"
            aria-label="Auto arrange"
            onClick={() => {
              syncPositionsBeforeOp();
              autoArrangeSelection();
              syncPositionsAfterOp();
            }}
            style={{
              background: 'transparent',
              color: 'var(--studio-fg)',
              border: '1px solid var(--studio-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            ⊞
          </button>
        </div>
      )}
      {onToggleYamlPreview ? (
        <button
          type="button"
          aria-pressed={!!isYamlPreviewOpen}
          onClick={onToggleYamlPreview}
          style={{
            background: isYamlPreviewOpen ? 'var(--studio-accent, #7c3aed)' : 'transparent',
            color: isYamlPreviewOpen ? '#fff' : 'var(--studio-fg)',
            border: '1px solid var(--studio-muted)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          YAML
        </button>
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
      {showThemePicker ? <ThemePicker /> : null}
      {onSave ? (
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
      ) : null}
    </header>
  );
}
