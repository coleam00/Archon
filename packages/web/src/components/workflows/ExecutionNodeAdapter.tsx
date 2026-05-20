import { useState, type ComponentType, type ReactElement } from 'react';
// Namespace import so test code can `spyOn(studioCore, 'getVariant')` and
// have the spy actually intercept the call site here (a direct named binding
// would be frozen at module-load time and bypass the spy).
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

const STATUS_STYLES: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'border-l-2 border-success bg-success/5',
  running: 'border-l-2 border-accent-bright bg-accent/5 shadow-[0_0_8px_var(--accent)]',
  failed: 'border-l-2 border-error bg-error/5',
  skipped: 'opacity-50 border-l-2 border-border',
};
const DEFAULT_STYLE = 'border-l-2 border-border bg-surface-elevated';

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
  const style = STATUS_STYLES[effectiveStatus] ?? DEFAULT_STYLE;
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

  return (
    <div
      data-testid="execution-node-adapter"
      data-variant={node.variant}
      data-status={effectiveStatus}
      className={`rounded-lg border border-border px-3 py-2 min-w-[140px] transition-all duration-300 ${style}${selected ? ' ring-2 ring-accent-bright' : ''}`}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={effectiveStatus} />
        <span className="text-[10px] font-medium text-text-tertiary">
          {node.variant.toUpperCase()}
        </span>
        {duration !== undefined && (
          <span className="text-[10px] text-text-tertiary ml-auto shrink-0">
            {formatDurationMs(duration)}
          </span>
        )}
      </div>
      <div
        data-testid="adapter-renderer-mount"
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
      {currentIteration !== undefined && maxIterations !== undefined && (
        <div className="text-[10px] text-text-tertiary mt-0.5">
          {currentIteration}/{maxIterations} iterations
        </div>
      )}
      {error && (
        <div
          data-testid="adapter-error-tail"
          className="text-[10px] text-error mt-1 truncate"
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
