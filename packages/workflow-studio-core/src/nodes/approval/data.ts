import type { ApprovalOnReject } from '../../schemas';
import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface ApprovalConfig {
  message: string;
  capture_response?: boolean;
  on_reject?: ApprovalOnReject;
}

export interface ApprovalNodeData {
  /** The approval config — lifted from the wire by reference. */
  approval: ApprovalConfig & Record<string, unknown>;
}

export function createApprovalDefault(): ApprovalNodeData {
  return {
    approval: {
      message: 'Approve to continue?',
    } as ApprovalNodeData['approval'],
  };
}

export const approvalCapabilities: VariantCapabilities = {
  honorsAiFields: false, // approval pauses execution; AI fields irrelevant
  forbidsRetry: false,
  requiresInteractive: true, // approval is fundamentally interactive
};

export const approvalLibrary: VariantLibraryMetadata = {
  label: 'Approval',
  description: 'Pause for human review',
  colorToken: 'node-approval',
  iconName: 'UserCheck',
  defaultIdHint: 'approve',
};
