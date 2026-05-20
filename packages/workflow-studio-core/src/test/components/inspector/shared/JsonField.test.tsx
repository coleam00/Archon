import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { JsonField } from '../../../../components/inspector/shared/JsonField';

describe('JsonField', () => {
  beforeEach(() => cleanup());

  it('emits parsed object on valid JSON blur', () => {
    let captured: unknown;
    render(
      <JsonField
        label="Settings"
        value={{ a: 1 }}
        onChange={v => {
          captured = v;
        }}
      />
    );
    const ta = screen.getByLabelText(/settings/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '{"a": 2, "b": 3}' } });
    fireEvent.blur(ta);
    expect(captured).toEqual({ a: 2, b: 3 });
  });

  it('shows parse error and does NOT emit on invalid JSON', () => {
    let calls = 0;
    render(
      <JsonField
        label="Settings"
        value={{}}
        onChange={() => {
          calls += 1;
        }}
      />
    );
    const ta = screen.getByLabelText(/settings/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '{a: 2}' } });
    fireEvent.blur(ta);
    expect(screen.getByText(/invalid json/i)).toBeDefined();
    expect(calls).toBe(0);
  });
});
