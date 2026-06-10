/** Approval variant: defaults + sparse fromDag/toDag conversion. */
import type { ApprovalNodeData, ApprovalOnReject, WireDagNode } from '../types';
import { ifDefined } from './if-defined';

/** Default approval config for a freshly-created approval node. */
export function defaultApprovalData(): ApprovalNodeData {
  return { message: 'Approve to continue?' };
}

/**
 * Build `ApprovalNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `approval` mode field is absent — importers must check field
 * presence first; defaults for new nodes come from `defaultApprovalData()`.
 */
export function approvalFromDag(variantSpecific: Partial<WireDagNode>): ApprovalNodeData {
  const approval = variantSpecific.approval;
  if (approval === undefined) {
    throw new Error(
      "approvalFromDag: wire node has no 'approval' field — use defaultApprovalData() for new nodes"
    );
  }
  return {
    message: approval.message,
    ...ifDefined('capture_response', approval.capture_response),
    ...ifDefined('on_reject', onRejectFragment(approval.on_reject)),
  };
}

/** Rebuild a sparse `on_reject` sub-object, or undefined when absent. */
function onRejectFragment(onReject: ApprovalOnReject | undefined): ApprovalOnReject | undefined {
  if (onReject === undefined) return undefined;
  return {
    prompt: onReject.prompt,
    ...ifDefined('max_attempts', onReject.max_attempts),
  };
}

/** Serialize `ApprovalNodeData` to the sparse `{ approval: … }` wire fragment. */
export function approvalToDag(data: ApprovalNodeData): Partial<WireDagNode> {
  return {
    approval: {
      message: data.message,
      ...ifDefined('capture_response', data.capture_response),
      ...ifDefined('on_reject', onRejectFragment(data.on_reject)),
    },
  };
}
