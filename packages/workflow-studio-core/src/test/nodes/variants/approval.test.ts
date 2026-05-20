import { describe, it, expect } from 'vitest';
import { approvalVariant } from '../../../nodes/approval';
import type { ApprovalNodeData } from '../../../nodes/approval';

describe('approval variant', () => {
  it('createDefault returns valid ApprovalNodeData with default message', () => {
    const d = approvalVariant.createDefault();
    expect(d.approval.message).toBe('Approve to continue?');
    expect(d.approval.capture_response).toBeUndefined();
    expect(d.approval.on_reject).toBeUndefined();
  });

  it('fromDag carries the approval config verbatim', () => {
    const input = {
      base: {
        id: 'test-approval',
        variant: 'approval',
        label: 'My Approval',
      },
      variantSpecific: {
        approval: {
          message: 'go?',
        },
      },
      raw: {} as any,
    };
    const result = approvalVariant.fromDag(input);
    expect(result.approval.message).toBe('go?');
  });

  it('fromDag preserves capture_response and on_reject', () => {
    const input = {
      base: {
        id: 'test-approval',
        variant: 'approval',
        label: 'My Approval',
      },
      variantSpecific: {
        approval: {
          message: 'go?',
          capture_response: true,
          on_reject: {
            prompt: 'why no?',
            max_attempts: 3,
          },
        },
      },
      raw: {} as any,
    };
    const result = approvalVariant.fromDag(input);
    expect(result.approval.message).toBe('go?');
    expect(result.approval.capture_response).toBe(true);
    expect(result.approval.on_reject?.prompt).toBe('why no?');
    expect(result.approval.on_reject?.max_attempts).toBe(3);
  });

  it('toDag produces { approval } verbatim', () => {
    const input: ApprovalNodeData = {
      approval: {
        message: 'go?',
      },
    };
    const result = approvalVariant.toDag(input);
    expect(result.approval).toEqual({
      message: 'go?',
    });
  });

  it('round-trips on_reject.max_attempts', () => {
    const input = {
      base: {
        id: 'test-approval',
        variant: 'approval',
        label: 'My Approval',
      },
      variantSpecific: {
        approval: {
          message: 'reason?',
          on_reject: {
            prompt: 'reason?',
            max_attempts: 5,
          },
        },
      },
      raw: {} as any,
    };
    const fromDagResult = approvalVariant.fromDag(input);
    const toDagResult = approvalVariant.toDag(fromDagResult);
    expect(toDagResult.approval?.on_reject?.max_attempts).toBe(5);
  });

  it('declares honorsAiFields = false and requiresInteractive = true', () => {
    expect(approvalVariant.capabilities.honorsAiFields).toBe(false);
    expect(approvalVariant.capabilities.requiresInteractive).toBe(true);
  });

  it('declares library metadata', () => {
    expect(approvalVariant.library.label).toBe('Approval');
    expect(approvalVariant.library.colorToken).toBe('node-approval');
    expect(approvalVariant.library.defaultIdHint).toBe('approve');
  });
});
