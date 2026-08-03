/**
 * Builder toolbar: history, clipboard, arrange, and view actions. Buttons are
 * token-styled (no shadcn); the primary action (auto-arrange) wears the
 * `.brand-bar` gradient. Key hints in the titles mirror the keymap table
 * (editor/keymap.ts) and the full list lives in the `?` help overlay.
 */
import type { ReactElement, ReactNode } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ClipboardPaste,
  Copy,
  Keyboard,
  Maximize,
  Redo2,
  Scissors,
  Undo2,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AlignMode } from '../editor/align';

interface ToolbarProps {
  workflowName: string;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  hasClipboard: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: 'h' | 'v') => void;
  onAutoArrange: () => void;
  onFitView: () => void;
  onToggleHelp: () => void;
}

function ToolButton({
  icon: Icon,
  title,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded-[7px] p-1.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
}

function Divider(): ReactElement {
  return <span aria-hidden className="mx-1 h-4 w-px bg-border" />;
}

function Group({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

export function Toolbar({
  workflowName,
  canUndo,
  canRedo,
  hasSelection,
  hasClipboard,
  onUndo,
  onRedo,
  onCopy,
  onCut,
  onPaste,
  onAlign,
  onDistribute,
  onAutoArrange,
  onFitView,
  onToggleHelp,
}: ToolbarProps): ReactElement {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-surface px-3 py-1.5">
      <span className="mr-2 truncate font-mono text-[12px] font-semibold text-text-primary">
        {workflowName}
      </span>

      <Group>
        <ToolButton icon={Undo2} title="Undo (u)" disabled={!canUndo} onClick={onUndo} />
        <ToolButton icon={Redo2} title="Redo (U)" disabled={!canRedo} onClick={onRedo} />
      </Group>
      <Divider />
      <Group>
        <ToolButton
          icon={Copy}
          title="Copy selection (y)"
          disabled={!hasSelection}
          onClick={onCopy}
        />
        <ToolButton
          icon={Scissors}
          title="Cut selection (x)"
          disabled={!hasSelection}
          onClick={onCut}
        />
        <ToolButton
          icon={ClipboardPaste}
          title="Paste (P)"
          disabled={!hasClipboard}
          onClick={onPaste}
        />
      </Group>
      <Divider />
      <Group>
        <ToolButton
          icon={AlignStartVertical}
          title="Align left (g l)"
          disabled={!hasSelection}
          onClick={(): void => {
            onAlign('left');
          }}
        />
        <ToolButton
          icon={AlignEndVertical}
          title="Align right (g r)"
          disabled={!hasSelection}
          onClick={(): void => {
            onAlign('right');
          }}
        />
        <ToolButton
          icon={AlignStartHorizontal}
          title="Align top (g t)"
          disabled={!hasSelection}
          onClick={(): void => {
            onAlign('top');
          }}
        />
        <ToolButton
          icon={AlignEndHorizontal}
          title="Align bottom (g b)"
          disabled={!hasSelection}
          onClick={(): void => {
            onAlign('bottom');
          }}
        />
        <ToolButton
          icon={AlignCenterVertical}
          title="Align horizontal centers (g c)"
          disabled={!hasSelection}
          onClick={(): void => {
            onAlign('centerV');
          }}
        />
        <ToolButton
          icon={AlignCenterHorizontal}
          title="Align vertical centers (g m)"
          disabled={!hasSelection}
          onClick={(): void => {
            onAlign('centerH');
          }}
        />
        <ToolButton
          icon={AlignHorizontalSpaceBetween}
          title="Distribute horizontally (g h)"
          disabled={!hasSelection}
          onClick={(): void => {
            onDistribute('h');
          }}
        />
        <ToolButton
          icon={AlignVerticalSpaceBetween}
          title="Distribute vertically (g v)"
          disabled={!hasSelection}
          onClick={(): void => {
            onDistribute('v');
          }}
        />
      </Group>
      <Divider />
      <Group>
        <ToolButton icon={Maximize} title="Fit view (f)" onClick={onFitView} />
        <ToolButton icon={Keyboard} title="Keyboard shortcuts (?)" onClick={onToggleHelp} />
      </Group>

      <div className="flex-1" />

      <button
        type="button"
        title="Auto-arrange the graph with dagre (A)"
        onClick={onAutoArrange}
        className="brand-bar flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12px] font-semibold text-white/95 transition-opacity hover:brightness-110"
      >
        <Workflow aria-hidden className="h-3.5 w-3.5" />
        Auto-arrange
      </button>
    </div>
  );
}
