import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { BuilderNode } from '@archon/workflow-studio-core';
import type { WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';
import { ExecutionNodeAdapter } from './ExecutionNodeAdapter';

export interface AdaptedNodeData extends Record<string, unknown> {
  builderNode: BuilderNode;
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

export type AdaptedFlowNode = Node<AdaptedNodeData>;

function AdaptedExecutionNodeRender({ data }: NodeProps<AdaptedFlowNode>): React.ReactElement {
  // Handles are NOT rendered here — the studio NodeShell (inside ExecutionNodeAdapter →
  // Renderer) already renders <Handle target Top /> and <Handle source Bottom /> at the
  // top/bottom edges of the 180×80 shell. Rendering them again on this wrapper would
  // place duplicate handles at the bottom of any expanded footer (error/approval gate),
  // dragging edge endpoints below the shell. pointer-events: none cascades to NodeShell's
  // handles but xyflow still finds them in the DOM for edge geometry (queries don't care
  // about pointer-events), so edges keep connecting correctly.
  return (
    <div data-testid="adapted-execution-node">
      <ExecutionNodeAdapter
        node={data.builderNode}
        status={data.status}
        duration={data.duration}
        error={data.error}
        currentIteration={data.currentIteration}
        maxIterations={data.maxIterations}
        selected={data.selected}
        runStatus={data.runStatus}
        approval={data.approval}
        onApprove={data.onApprove}
        onReject={data.onReject}
        isApproving={data.isApproving}
        isRejecting={data.isRejecting}
      />
    </div>
  );
}

export const adaptedExecutionNode = memo(AdaptedExecutionNodeRender);
