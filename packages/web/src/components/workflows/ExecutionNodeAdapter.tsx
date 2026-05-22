import { useState, type ComponentType, type ReactElement } from 'react';
// CLAUDE.md normally prohibits `import *` for main packages; this is a
// deliberate exception. Bun's `spyOn(module, 'export')` patches the namespace
// object's binding — for the spy to be observed at the consumer call site,
// the consumer MUST resolve through the same namespace binding (a direct
// named import is frozen at module-load time and bypasses the spy). The
// only call below is `studioCore.getVariant(...)`; the named `BuilderNode`
// type import on the next line is the project's preferred pattern for the
// non-spied surface.
import * as studioCore from '@archon/workflow-studio-core';
import type { BuilderNode } from '@archon/workflow-studio-core';
import type { WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';
import { formatDurationMs } from '@/lib/format';
import { StatusIcon } from './StatusIcon';

export interface ExecutionNodeAdapterProps {
  node: BuilderNode;
  status?: WorkflowStepStatus;
  duration?: number;
  error?: string;
  currentIteration?: number;
  maxIterations?: number;
  selected?: boolean;
  runStatus?: WorkflowRunStatus;
  approval?: { nodeId: string; message: string };
  onApprove?: (comment?: string) => void;
  onReject?: (reason: string) => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}

// Status decoration is layered ON the studio NodeShell (which is the primary visual:
// colored variant stripe + variant tag pill from @archon/workflow-studio-core). We
// use filter: drop-shadow so the halo traces NodeShell's rounded shape; box-shadow
// would render a misaligned rectangle around the protruding colored stripe.
const STATUS_FX_CLASS: Partial<Record<WorkflowStepStatus, string>> = {
  running: 'drop-shadow-[0_0_8px_var(--accent-bright)] animate-pulse [animation-duration:2s]',
  failed: 'drop-shadow-[0_0_6px_var(--error)]',
  completed: 'drop-shadow-[0_0_4px_var(--success)]',
  skipped: 'opacity-50',
  pending: 'opacity-80',
};

// NodeShell is fixed at 180x80 in @archon/workflow-studio-core; mirror that width on
// the wrapper so the optional footer rows (duration, error, approval gate) align
// cleanly under the shell without stretching past it.
const SHELL_WIDTH = 180;

// Edit-affordance suppression is via `pointer-events: none`; this leaves the DOM
// reachable by keyboard tab order. If Phase 5 surfaces a focus issue inside the
// disabled body, upgrade to `inert` or `aria-hidden="true"` per plan risks §4.

export function ExecutionNodeAdapter(props: ExecutionNodeAdapterProps): ReactElement {
  const {
    node,
    status,
    duration,
    error,
    currentIteration,
    maxIterations,
    selected,
    runStatus,
    approval,
    onApprove,
    onReject,
    isApproving,
    isRejecting,
  } = props;

  const effectiveStatus: WorkflowStepStatus = status ?? 'pending';
  const fxClass = STATUS_FX_CLASS[effectiveStatus] ?? '';
  const variantDef = studioCore.getVariant(node.variant);

  // xyflow v12's NodeProps has ~10 required positional fields (positionAbsoluteX,
  // zIndex, isConnectable, etc.). The variant Renderers themselves only read
  // `data` and `selected` (see e.g. packages/workflow-studio-core/src/nodes/approval/Renderer.tsx).
  // Cast to a permissive component type so the mount site stays small; the
  // Renderer is rendered inside a `pointer-events: none` container so its
  // interactive surface is suppressed anyway.
  // PascalCase here is required by JSX (the variable IS a React component);
  // the naming-convention rule's default formats (camelCase / UPPER_CASE) don't
  // anticipate this React idiom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/naming-convention -- xyflow NodeProps shape; see comment above
  const Renderer = variantDef.Renderer as ComponentType<any>;

  const showApprovalGate =
    runStatus === 'paused' && node.variant === 'approval' && approval?.nodeId === node.id;
  const hasFooterRow =
    duration !== undefined || (currentIteration !== undefined && maxIterations !== undefined);

  return (
    <div
      data-testid="execution-node-adapter"
      data-variant={node.variant}
      data-status={effectiveStatus}
      className="relative"
      style={{ width: SHELL_WIDTH }}
    >
      {/* Studio NodeShell is the primary visual: colored variant stripe + tag pill. */}
      {/* filter: drop-shadow traces NodeShell's actual rounded shape including its */}
      {/* protruding stripe (box-shadow on a wrapper would clip to a rectangle). */}
      <div
        data-testid="adapter-renderer-mount"
        className={`transition-[filter,opacity] duration-300 ${fxClass}`}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        <Renderer
          id={node.id}
          type={node.variant}
          data={{ storeId: node.id, node }}
          selected={selected ?? false}
          dragging={false}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          zIndex={0}
        />
      </div>

      {/* Status icon as a corner badge overlaid on the shell's top-right. */}
      {/* The background+blur+ring keep it legible against the colored variant tag. */}
      <div className="absolute top-1 right-1 z-10 rounded-full bg-surface/85 backdrop-blur-sm p-0.5 ring-1 ring-border">
        <StatusIcon status={effectiveStatus} />
      </div>

      {/* Footer row beneath the shell: iteration counter (left) + duration (right). */}
      {hasFooterRow && (
        <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-text-tertiary">
          <span>
            {currentIteration !== undefined && maxIterations !== undefined
              ? `${currentIteration}/${maxIterations}`
              : ''}
          </span>
          {duration !== undefined && <span>{formatDurationMs(duration)}</span>}
        </div>
      )}

      {error && (
        <div
          data-testid="adapter-error-tail"
          className="mt-1 text-[10px] text-error truncate"
          title={error}
        >
          {error.slice(0, 60)}
        </div>
      )}

      {showApprovalGate && (
        <div style={{ pointerEvents: 'auto' }}>
          <ApprovalGateControls
            onApprove={onApprove}
            onReject={onReject}
            isApproving={isApproving}
            isRejecting={isRejecting}
          />
        </div>
      )}
    </div>
  );
}

interface ApprovalGateControlsProps {
  onApprove?: (comment?: string) => void;
  onReject?: (reason: string) => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}

function ApprovalGateControls(props: ApprovalGateControlsProps): ReactElement {
  const { onApprove, onReject, isApproving, isRejecting } = props;
  const [mode, setMode] = useState<'idle' | 'approve' | 'reject'>('idle');
  const [text, setText] = useState('');

  const openApprove = (): void => {
    setMode('approve');
  };
  const openReject = (): void => {
    setMode('reject');
  };
  const close = (): void => {
    setMode('idle');
    setText('');
  };
  const submitApprove = (): void => {
    onApprove?.(text.trim() || undefined);
    close();
  };
  const submitReject = (): void => {
    const reason = text.trim();
    if (!reason) return;
    onReject?.(reason);
    close();
  };

  if (mode === 'idle') {
    return (
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          data-testid="approval-approve-button"
          onClick={openApprove}
          disabled={isApproving === true}
          className="text-[10px] px-2 py-1 rounded bg-success/20 text-success disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="approval-reject-button"
          onClick={openReject}
          disabled={isRejecting === true}
          className="text-[10px] px-2 py-1 rounded bg-error/20 text-error disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    );
  }

  const isReject = mode === 'reject';
  const canSubmit = isReject ? text.trim().length > 0 : true;
  const inFlight = isReject ? isRejecting === true : isApproving === true;

  return (
    <div data-testid="approval-popover" className="mt-2 flex flex-col gap-2">
      <textarea
        data-testid="approval-popover-textarea"
        value={text}
        onChange={(e): void => {
          setText(e.target.value);
        }}
        placeholder={isReject ? 'Reason (required)' : 'Comment (optional)'}
        className="text-[10px] p-1 border border-border rounded"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="approval-popover-submit"
          onClick={isReject ? submitReject : submitApprove}
          disabled={!canSubmit || inFlight}
          className={`text-[10px] px-2 py-1 rounded disabled:opacity-50 ${isReject ? 'bg-error/20 text-error' : 'bg-success/20 text-success'}`}
        >
          {isReject ? 'Submit reject' : 'Submit approve'}
        </button>
        <button
          type="button"
          data-testid="approval-popover-cancel"
          onClick={close}
          className="text-[10px] px-2 py-1 rounded border border-border"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
