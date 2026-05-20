import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CommandInspector } from '../../../nodes/command/Inspector';

describe('CommandInspector', () => {
  beforeEach(() => cleanup());

  it('renders the Command body field', () => {
    render(
      <CommandInspector
        id="n1"
        data={{ command: 'classify' }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect(screen.getByLabelText(/^command$/i)).toBeDefined();
  });

  it('emits patch on Command edit', () => {
    let captured: Record<string, unknown> | null = null;
    render(
      <CommandInspector
        id="n1"
        data={{ command: 'classify' }}
        base={{}}
        unknown={{}}
        onChange={p => {
          captured = p;
        }}
        siblingIds={[]}
      />
    );
    fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: 'review' } });
    expect(captured).toEqual({ command: 'review' });
  });
});
