import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CancelInspector } from '../../../nodes/cancel/Inspector';

describe('CancelInspector', () => {
  beforeEach(() => cleanup());

  it('renders the Cancel reason field', () => {
    render(
      <CancelInspector
        id="n1"
        data={{ cancel: 'budget exceeded' }}
        base={{}}
        unknown={{}}
        onChange={() => {}}
        siblingIds={[]}
      />
    );
    expect((screen.getByLabelText(/cancel reason/i) as HTMLTextAreaElement).value).toBe(
      'budget exceeded'
    );
  });

  it('emits a patch on Cancel reason edit', () => {
    let captured: Record<string, unknown> | null = null;
    render(
      <CancelInspector
        id="n1"
        data={{ cancel: '' }}
        base={{}}
        unknown={{}}
        onChange={p => {
          captured = p;
        }}
        siblingIds={[]}
      />
    );
    fireEvent.change(screen.getByLabelText(/cancel reason/i), { target: { value: 'stop' } });
    expect(captured).toEqual({ cancel: 'stop' });
  });
});
