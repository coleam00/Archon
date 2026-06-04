/** Approval variant: defaults + sparse fromDag/toDag conversion. */
import type { ApprovalNodeData, WireDagNode } from '../types';

/** Default approval config for a freshly-created approval node. */
export function defaultApprovalData(): ApprovalNodeData {
  return { message: 'Approve to continue?' };
}

/** Build `ApprovalNodeData` from a partitioned wire node's variant-specific fields. */
export function approvalFromDag(variantSpecific: Partial<WireDagNode>): ApprovalNodeData {
  const approval = variantSpecific.approval;
  if (!approval) return defaultApprovalData();
  return {
    message: approval.message,
    ...(approval.capture_response !== undefined
      ? { capture_response: approval.capture_response }
      : {}),
    ...(approval.on_reject !== undefined
      ? {
          on_reject: {
            prompt: approval.on_reject.prompt,
            ...(approval.on_reject.max_attempts !== undefined
              ? { max_attempts: approval.on_reject.max_attempts }
              : {}),
          },
        }
      : {}),
  };
}

/** Serialize `ApprovalNodeData` to the sparse `{ approval: … }` wire fragment. */
export function approvalToDag(data: ApprovalNodeData): Partial<WireDagNode> {
  return {
    approval: {
      message: data.message,
      ...(data.capture_response !== undefined ? { capture_response: data.capture_response } : {}),
      ...(data.on_reject !== undefined
        ? {
            on_reject: {
              prompt: data.on_reject.prompt,
              ...(data.on_reject.max_attempts !== undefined
                ? { max_attempts: data.on_reject.max_attempts }
                : {}),
            },
          }
        : {}),
    },
  };
}
