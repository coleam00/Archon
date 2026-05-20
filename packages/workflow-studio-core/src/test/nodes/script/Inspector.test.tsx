import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ScriptInspector } from '../../../nodes/script/Inspector';

describe('ScriptInspector', () => {
  beforeEach(() => cleanup());

  it('renders Script + Runtime + Deps + Timeout fields', () => {
    render(
      <ScriptInspector
        id="n1"
        data={{ script: '', runtime: 'bun' }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^script$/i)).toBeDefined();
    expect(screen.getByLabelText(/^runtime$/i)).toBeDefined();
    expect(screen.getByLabelText(/^deps$/i)).toBeDefined();
    expect(screen.getByLabelText(/^timeout$/i)).toBeDefined();
  });

  it('emits patch with deps array on multiline edit', () => {
    let captured: Record<string, unknown> | null = null;
    render(
      <ScriptInspector
        id="n1"
        data={{ script: '', runtime: 'bun' }}
        base={{}}
        unknown={{}}
        onChange={p => {
          captured = p;
        }}
        siblingIds={[]}
      />
    );
    fireEvent.change(screen.getByLabelText(/^deps$/i), {
      target: { value: 'lodash@4\n  zod@3\n' },
    });
    expect(captured).toEqual({ deps: ['lodash@4', 'zod@3'] });
  });
});
