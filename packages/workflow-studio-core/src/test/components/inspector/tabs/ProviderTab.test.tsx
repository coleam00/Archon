import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ProviderTab } from '../../../../components/inspector/tabs/ProviderTab';

const renderTab = (
  base: Record<string, unknown>,
  onChange: (p: Record<string, unknown>) => void = () => {}
) =>
  render(
    <ProviderTab
      id="n"
      data={undefined}
      base={base}
      unknown={{}}
      onChange={onChange}
      siblingIds={[]}
    />
  );

describe('ProviderTab', () => {
  beforeEach(() => cleanup());

  it('renders provider, model, fallback model, system prompt, effort, max budget, thinking, betas', () => {
    renderTab({});
    expect(screen.getByLabelText(/^provider$/i)).toBeDefined();
    expect(screen.getByLabelText(/^model$/i)).toBeDefined();
    expect(screen.getByLabelText(/fallback model/i)).toBeDefined();
    expect(screen.getByLabelText(/system prompt/i)).toBeDefined();
    expect(screen.getByLabelText(/^effort$/i)).toBeDefined();
    expect(screen.getByLabelText(/max budget/i)).toBeDefined();
    expect(screen.getByLabelText(/^thinking$/i)).toBeDefined();
    expect(screen.getByLabelText(/^betas$/i)).toBeDefined();
  });

  it('emits provider patch on select change', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: 'anthropic' } });
    expect(captured).toEqual({ provider: 'anthropic' });
  });

  it('emits provider: null when cleared back to (inherit)', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ provider: 'openai' }, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: '' } });
    expect(captured).toEqual({ provider: null });
  });

  it('emits model edit', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: 'claude-opus-4-7' } });
    expect(captured).toEqual({ model: 'claude-opus-4-7' });
  });

  it('emits thinking JSON on blur', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ thinking: {} }, p => {
      captured = p;
    });
    const ta = screen.getByLabelText(/^thinking$/i);
    fireEvent.change(ta, { target: { value: '{"type": "enabled", "budgetTokens": 8000}' } });
    fireEvent.blur(ta);
    expect(captured).toEqual({ thinking: { type: 'enabled', budgetTokens: 8000 } });
  });

  it('emits betas as a string array from line-per-row textarea', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({}, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/^betas$/i), {
      target: { value: 'computer-use-2025-01-24\ninterleaved-thinking-2025-05-14' },
    });
    expect(captured).toEqual({
      betas: ['computer-use-2025-01-24', 'interleaved-thinking-2025-05-14'],
    });
  });
});
