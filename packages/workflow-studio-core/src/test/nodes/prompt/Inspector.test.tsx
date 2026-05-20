import { beforeEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { PromptInspector } from '../../../nodes/prompt/Inspector';

// Phase 5 migrated the prompt body to CmEditor — see drift §5.6.1. Typing
// simulation against contenteditable is covered by CmEditor.spec.tsx; here
// we verify the inspector wires data.prompt into the editor and exposes the
// Prompt label so accessibility-keyed lookups still work.

describe('PromptInspector', () => {
  beforeEach(() => cleanup());

  it('renders the Prompt body in a CmEditor populated from data.prompt', () => {
    const { container } = render(
      <PromptInspector
        id="n1"
        data={{ prompt: 'classify the input' }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    const editor = screen.getByLabelText(/^prompt$/i);
    expect(editor).toBeDefined();
    expect(editor.textContent).toContain('classify the input');
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });
});
