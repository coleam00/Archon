/** Approval variant: defaults + sparse fromDag/toDag conversion. */
import type { ApprovalNodeData, WireDagNode } from '../types';
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
  return copyApproval(approval);
}

/**
 * A copy of the approval object and of its `on_reject`, so the builder never
 * shares an object with the definition it was read from. Copied whole rather
 * than key by key: an approval field this file does not name still survives.
 */
function copyApproval(approval: ApprovalNodeData): ApprovalNodeData {
  return {
    ...approval,
    ...ifDefined('on_reject', approval.on_reject && { ...approval.on_reject }),
  };
}

/** Serialize `ApprovalNodeData` to the sparse `{ approval: … }` wire fragment. */
export function approvalToDag(data: ApprovalNodeData): Partial<WireDagNode> {
  return { approval: copyApproval(data) };
}
