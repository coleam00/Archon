import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BashInspector } from '../../../nodes/bash/Inspector';

describe('BashInspector', () => {
  beforeEach(() => cleanup());

  it('renders the Bash body textarea + timeout input', () => {
    render(
      <BashInspector
        id="n1"
        data={{ bash: 'echo hi' }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^bash$/i)).toBeDefined();
    expect(screen.getByLabelText(/^timeout$/i)).toBeDefined();
  });

  it('renders bash body in a CmEditor populated from data.bash', () => {
    // Phase 5 migrated bash body to CmEditor — see drift §5.6.1. Typing
    // simulation against contenteditable is covered by CmEditor.spec.tsx.
    const { container } = render(
      <BashInspector
        id="n1"
        data={{ bash: 'ls -la' }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^bash$/i).textContent).toContain('ls -la');
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });

  it('emits null timeout when the input is cleared', () => {
    let captured: Record<string, unknown> | null = null;
    render(
      <BashInspector
        id="n1"
        data={{ bash: '', timeout: 5000 }}
        base={{}}
        unknown={{}}
        onChange={p => {
          captured = p;
        }}
        siblingIds={[]}
      />
    );
    fireEvent.change(screen.getByLabelText(/^timeout$/i), { target: { value: '' } });
    expect(captured).toEqual({ timeout: null });
  });
});
