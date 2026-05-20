import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LoopInspector } from '../../../nodes/loop/Inspector';

const baseLoop = {
  prompt: 'iterate',
  until: 'COMPLETE',
  max_iterations: 5,
  fresh_context: false,
};

describe('LoopInspector', () => {
  beforeEach(() => cleanup());

  it('renders Prompt + Until + Max iterations + Fresh context + Interactive', () => {
    render(
      <LoopInspector
        id="n1"
        data={{ loop: baseLoop }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^prompt$/i)).toBeDefined();
    expect(screen.getByLabelText(/^until$/i)).toBeDefined();
    expect(screen.getByLabelText(/max iterations/i)).toBeDefined();
    expect(screen.getByLabelText(/fresh context/i)).toBeDefined();
    expect(screen.getByLabelText(/^interactive$/i)).toBeDefined();
  });

  it('renders loop.prompt in a CmEditor populated from data.loop.prompt', () => {
    // Phase 5 migrated loop.prompt to CmEditor; typing simulation is
    // covered by CmEditor.spec.tsx. The deep-merge patch shape is still
    // exercised on other (non-CmEditor) fields like fresh_context.
    const { container } = render(
      <LoopInspector
        id="n1"
        data={{ loop: baseLoop }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^prompt$/i).textContent).toContain('iterate');
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });

  it('reveals the gate_message field only when interactive is on', () => {
    const { rerender } = render(
      <LoopInspector
        id="n1"
        data={{ loop: baseLoop }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.queryByLabelText(/gate message/i)).toBeNull();
    rerender(
      <LoopInspector
        id="n1"
        data={{ loop: { ...baseLoop, interactive: true } }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/gate message/i)).toBeDefined();
  });
});
