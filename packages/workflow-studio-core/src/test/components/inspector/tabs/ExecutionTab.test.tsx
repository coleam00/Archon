import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ExecutionTab } from '../../../../components/inspector/tabs/ExecutionTab';

const renderTab = (
  base: Record<string, unknown>,
  forbidsRetry: boolean,
  onChange: (p: Record<string, unknown>) => void = () => {}
) =>
  render(
    <ExecutionTab
      id="n"
      data={undefined}
      base={base}
      unknown={{}}
      onChange={onChange}
      siblingIds={[]}
      forbidsRetry={forbidsRetry}
    />
  );

describe('ExecutionTab', () => {
  beforeEach(() => cleanup());

  it('renders idle_timeout, retry max_attempts, retry delay_ms, retry on_error, sandbox', () => {
    renderTab({}, false);
    expect(screen.getByLabelText(/idle timeout/i)).toBeDefined();
    expect(screen.getByLabelText(/retry max attempts/i)).toBeDefined();
    expect(screen.getByLabelText(/retry delay/i)).toBeDefined();
    expect(screen.getByLabelText(/retry on error/i)).toBeDefined();
    expect(screen.getByLabelText(/sandbox/i)).toBeDefined();
  });

  it('emits nested retry patch on max_attempts edit', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ retry: { max_attempts: 1 } }, false, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/retry max attempts/i), { target: { value: '5' } });
    expect(captured).toEqual({ retry: { max_attempts: 5 } });
  });

  it('emits idle_timeout: null when cleared', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ idle_timeout: 30 }, false, p => {
      captured = p;
    });
    fireEvent.change(screen.getByLabelText(/idle timeout/i), { target: { value: '' } });
    expect(captured).toEqual({ idle_timeout: null });
  });

  it('shows the forbidden banner and disables retry inputs when forbidsRetry=true', () => {
    renderTab({}, true);
    expect(screen.getByText(/loop variants forbid retry/i)).toBeDefined();
    expect((screen.getByLabelText(/retry max attempts/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/retry delay/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/retry on error/i) as HTMLSelectElement).disabled).toBe(true);
  });

  it('emits sandbox JSON edit on blur', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ sandbox: {} }, false, p => {
      captured = p;
    });
    const ta = screen.getByLabelText(/sandbox/i);
    fireEvent.change(ta, { target: { value: '{"enabled": true}' } });
    fireEvent.blur(ta);
    expect(captured).toEqual({ sandbox: { enabled: true } });
  });
});
