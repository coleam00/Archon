import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToolsTab } from '../../../../components/inspector/tabs/ToolsTab';

const renderTab = (
  base: Record<string, unknown>,
  onChange: (p: Record<string, unknown>) => void = () => {}
) =>
  render(
    <ToolsTab
      id="n"
      data={undefined}
      base={base}
      unknown={{}}
      onChange={onChange}
      siblingIds={[]}
    />
  );

describe('ToolsTab', () => {
  beforeEach(() => cleanup());

  it('renders allowed_tools, denied_tools, output_format', () => {
    renderTab({});
    expect(screen.getByLabelText(/allowed tools/i)).toBeDefined();
    expect(screen.getByLabelText(/denied tools/i)).toBeDefined();
    expect(screen.getByLabelText(/output format/i)).toBeDefined();
  });

  it('emits allowed_tools as a string array on edit', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), {
      target: { value: 'Read\nEdit\nGrep' },
    });
    expect(captured).toEqual({ allowed_tools: ['Read', 'Edit', 'Grep'] });
  });

  it('emits allowed_tools: null when cleared', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ allowed_tools: ['Read'] }, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), { target: { value: '' } });
    expect(captured).toEqual({ allowed_tools: null });
  });

  it('emits denied_tools using the schema field name (not disallowed_tools)', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/denied tools/i), { target: { value: 'WebFetch' } });
    expect(captured).toEqual({ denied_tools: ['WebFetch'] });
  });

  it('emits output_format JSON on blur', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ output_format: {} }, p => {
      captured = p;
    });
    const ta = screen.getByLabelText(/output format/i);
    fireEvent.change(ta, { target: { value: '{"score": "number"}' } });
    fireEvent.blur(ta);
    expect(captured).toEqual({ output_format: { score: 'number' } });
  });
});
