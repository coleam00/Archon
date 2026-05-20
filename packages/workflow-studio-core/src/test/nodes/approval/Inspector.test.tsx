import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ApprovalInspector } from '../../../nodes/approval/Inspector';

describe('ApprovalInspector', () => {
  beforeEach(() => cleanup());

  it('renders Message + Capture response + On reject prompt fields', () => {
    render(
      <ApprovalInspector
        id="n1"
        data={{ approval: { message: 'Approve?' } }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^message$/i)).toBeDefined();
    expect(screen.getByLabelText(/capture response/i)).toBeDefined();
    expect(screen.getByLabelText(/on reject prompt/i)).toBeDefined();
  });

  it('renders approval.message in a CmEditor populated from data.approval.message', () => {
    // Phase 5 migrated approval.message to CmEditor; typing simulation is
    // covered by CmEditor.spec.tsx.
    const { container } = render(
      <ApprovalInspector
        id="n1"
        data={{ approval: { message: 'Please approve.' } }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^message$/i).textContent).toContain('Please approve.');
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });
});
