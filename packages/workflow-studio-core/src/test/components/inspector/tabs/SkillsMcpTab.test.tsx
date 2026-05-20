import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SkillsMcpTab } from '../../../../components/inspector/tabs/SkillsMcpTab';

const renderTab = (
  base: Record<string, unknown>,
  onChange: (p: Record<string, unknown>) => void = () => {}
) =>
  render(
    <SkillsMcpTab
      id="n"
      data={undefined}
      base={base}
      unknown={{}}
      onChange={onChange}
      siblingIds={[]}
    />
  );

describe('SkillsMcpTab', () => {
  beforeEach(() => cleanup());

  it('renders skills (textarea) and mcp (input)', () => {
    renderTab({});
    expect(screen.getByLabelText(/^skills$/i)).toBeDefined();
    expect(screen.getByLabelText(/mcp config path/i)).toBeDefined();
  });

  it('emits skills as a string array on edit', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/^skills$/i), {
      target: { value: 'reviewing-code\ntdd' },
    });
    expect(captured).toEqual({ skills: ['reviewing-code', 'tdd'] });
  });

  it('emits mcp as a string path', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/mcp config path/i), {
      target: { value: '.archon/mcp.json' },
    });
    expect(captured).toEqual({ mcp: '.archon/mcp.json' });
  });

  it('emits mcp: null when cleared', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ mcp: 'some/path' }, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/mcp config path/i), { target: { value: '' } });
    expect(captured).toEqual({ mcp: null });
  });
});
