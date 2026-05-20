import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DependsOnEditor } from '../../../../components/inspector/shared/DependsOnEditor';

describe('DependsOnEditor', () => {
  beforeEach(() => cleanup());

  it('renders a chip per existing dependency', () => {
    render(
      <DependsOnEditor
        value={['classify', 'review']}
        siblingIds={['classify', 'review', 'dispatch']}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('classify')).toBeDefined();
    expect(screen.getByText('review')).toBeDefined();
  });

  it('removes a chip on click and emits new array', () => {
    let captured: string[] = [];
    render(
      <DependsOnEditor
        value={['classify', 'review']}
        siblingIds={['classify', 'review']}
        onChange={v => {
          captured = v;
        }}
      />
    );
    fireEvent.click(screen.getByLabelText(/remove classify/i));
    expect(captured).toEqual(['review']);
  });

  it('autocompletes a prefix from siblingIds on Enter', () => {
    let captured: string[] = [];
    render(
      <DependsOnEditor
        value={[]}
        siblingIds={['classify', 'review', 'dispatch']}
        onChange={v => {
          captured = v;
        }}
      />
    );
    const input = screen.getByLabelText(/add dependency/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rev' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(captured).toEqual(['review']);
  });

  it('rejects unknown ids with an error and does not emit', () => {
    let captured: string[] | null = null;
    render(
      <DependsOnEditor
        value={[]}
        siblingIds={['classify']}
        onChange={v => {
          captured = v;
        }}
      />
    );
    const input = screen.getByLabelText(/add dependency/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(captured).toBeNull();
    expect(screen.getByText(/unknown id/i)).toBeDefined();
  });
});
