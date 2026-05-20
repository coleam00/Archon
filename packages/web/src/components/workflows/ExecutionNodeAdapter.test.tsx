import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ReactElement } from 'react';
import * as studioCore from '@archon/workflow-studio-core';
import type { BuilderNode, VariantDefinition, VariantId } from '@archon/workflow-studio-core';
import { ExecutionNodeAdapter } from './ExecutionNodeAdapter';
import type { WorkflowStepStatus } from '@/lib/types';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

const VARIANTS: readonly VariantId[] = [
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
];
const STATUSES: readonly WorkflowStepStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
];

let getVariantSpy: Mock<typeof studioCore.getVariant>;

beforeEach(() => {
  getVariantSpy = spyOn(studioCore, 'getVariant').mockImplementation(
    // `getVariant` is generic in TData; the mock must match that signature.
    // The trailing comma in `<TData,>` is the standard `.tsx` workaround for
    // generic arrow functions (the bare `<TData>` would be parsed as JSX).
    <TData,>(id: VariantId): VariantDefinition<TData> => {
      function StubRenderer(): ReactElement {
        return <div data-testid={`studio-renderer-${id}`} />;
      }
      // The adapter only reads `Renderer`; the other VariantDefinition fields are
      // never touched, so we cast through `unknown` to avoid hand-stubbing them.
      return { Renderer: StubRenderer } as unknown as VariantDefinition<TData>;
    }
  );
});

afterEach(() => {
  getVariantSpy.mockRestore();
  cleanup();
});

function mkNode(variant: VariantId, id = 'n1'): BuilderNode {
  return { id, variant, data: {}, base: {}, unknown: {} };
}

describe('ExecutionNodeAdapter — variant × status matrix', () => {
  for (const variant of VARIANTS) {
    for (const status of STATUSES) {
      it(`renders variant=${variant} at status=${status}`, () => {
        render(<ExecutionNodeAdapter node={mkNode(variant)} status={status} duration={1234} />);
        const root = screen.getByTestId('execution-node-adapter');
        expect(root.getAttribute('data-variant')).toBe(variant);
        expect(root.getAttribute('data-status')).toBe(status);
        expect(screen.getByTestId(`studio-renderer-${variant}`)).toBeDefined();
        // formatDurationMs(1234) → '1.2s'
        expect(root.textContent).toContain('1.2s');
      });
    }
  }
});

describe('ExecutionNodeAdapter — approval gate', () => {
  it('shows Approve/Reject when runStatus=paused, variant=approval, matching nodeId', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
      />
    );
    expect(screen.getByTestId('approval-approve-button')).toBeDefined();
    expect(screen.getByTestId('approval-reject-button')).toBeDefined();
  });

  it('does NOT show buttons for non-approval variants when runStatus=paused', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('command', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
      />
    );
    expect(screen.queryByTestId('approval-approve-button')).toBeNull();
    expect(screen.queryByTestId('approval-reject-button')).toBeNull();
  });

  it('does NOT show buttons when approval.nodeId does not match node.id', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'different-gate', message: 'Approve?' }}
      />
    );
    expect(screen.queryByTestId('approval-approve-button')).toBeNull();
  });

  it('Approve flow: click Approve → submit empty popover → onApprove called with undefined', () => {
    const calls: { comment: string | undefined }[] = [];
    function onApprove(comment?: string): void {
      calls.push({ comment });
    }
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
        onApprove={onApprove}
      />
    );
    fireEvent.click(screen.getByTestId('approval-approve-button'));
    expect(screen.getByTestId('approval-popover')).toBeDefined();
    fireEvent.click(screen.getByTestId('approval-popover-submit'));
    expect(calls).toEqual([{ comment: undefined }]);
  });

  it('Reject flow: click Reject → enter reason → submit → onReject called with reason', () => {
    const calls: string[] = [];
    function onReject(reason: string): void {
      calls.push(reason);
    }
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
        onReject={onReject}
      />
    );
    fireEvent.click(screen.getByTestId('approval-reject-button'));
    const textarea = screen.getByTestId('approval-popover-textarea');
    fireEvent.change(textarea, { target: { value: 'looks broken' } });
    fireEvent.click(screen.getByTestId('approval-popover-submit'));
    expect(calls).toEqual(['looks broken']);
  });

  it('Reject submit is disabled until reason is non-empty', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
        onReject={(): void => {
          /* test-only no-op: this case only exercises the disabled-state UI */
        }}
      />
    );
    fireEvent.click(screen.getByTestId('approval-reject-button'));
    const submit = screen.getByTestId<HTMLButtonElement>('approval-popover-submit');
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('approval-popover-textarea'), {
      target: { value: 'x' },
    });
    expect(submit.disabled).toBe(false);
  });
});

describe('ExecutionNodeAdapter — ancillary behavior', () => {
  it('renderer mount has pointer-events: none (edit-affordance suppression)', () => {
    render(<ExecutionNodeAdapter node={mkNode('command')} status="running" />);
    const mount = screen.getByTestId('adapter-renderer-mount');
    expect(mount.style.pointerEvents).toBe('none');
    expect(mount.style.userSelect).toBe('none');
  });

  it('disables Approve button while isApproving is true', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
        isApproving={true}
      />
    );
    const approve = screen.getByTestId<HTMLButtonElement>('approval-approve-button');
    expect(approve.disabled).toBe(true);
  });

  it('disables Reject button while isRejecting is true', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('approval', 'gate1')}
        runStatus="paused"
        approval={{ nodeId: 'gate1', message: 'Approve?' }}
        isRejecting={true}
      />
    );
    const reject = screen.getByTestId<HTMLButtonElement>('approval-reject-button');
    expect(reject.disabled).toBe(true);
  });

  it('shows iteration counter when currentIteration + maxIterations both provided', () => {
    render(
      <ExecutionNodeAdapter
        node={mkNode('loop')}
        status="running"
        currentIteration={3}
        maxIterations={10}
      />
    );
    expect(screen.getByTestId('execution-node-adapter').textContent).toContain('3/10');
  });

  it('renders truncated error footer with full text in title attribute', () => {
    const longError = 'x'.repeat(120);
    render(<ExecutionNodeAdapter node={mkNode('bash')} status="failed" error={longError} />);
    const tail = screen.getByTestId('adapter-error-tail');
    expect(tail.textContent?.length).toBe(60);
    expect(tail.getAttribute('title')).toBe(longError);
  });
});
