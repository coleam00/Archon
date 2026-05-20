import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ValidationPanel } from '../../components/ValidationPanel';
import type { Issue } from '../../validation/types';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterEach(() => cleanup());

const mkIssue = (over: Partial<Issue> = {}): Issue => ({
  id: 'i',
  rule: 'r',
  severity: 'error',
  source: 'client-instant',
  message: 'oops',
  path: {},
  ...over,
});

describe('ValidationPanel', () => {
  it('renders the collapsed pill summary with severity counts', () => {
    render(
      <ValidationPanel
        issues={[mkIssue({ id: '1' }), mkIssue({ id: '2', severity: 'warning' })]}
        expanded={false}
        onToggle={() => {}}
        onFocusIssue={() => {}}
      />
    );
    expect(screen.getByText(/1 error/i)).toBeTruthy();
    expect(screen.getByText(/1 warning/i)).toBeTruthy();
  });

  it('reports the new expanded state when the bar is clicked', () => {
    let toggled: boolean | null = null;
    render(
      <ValidationPanel
        issues={[mkIssue()]}
        expanded={false}
        onToggle={n => (toggled = n)}
        onFocusIssue={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /expand validation panel/i }));
    expect(toggled).toBe(true);
  });

  it('dispatches focusIssue on row click', () => {
    let focused: string | undefined;
    render(
      <ValidationPanel
        issues={[mkIssue({ message: 'oops', path: { nodeId: 'a' } })]}
        expanded={true}
        onToggle={() => {}}
        onFocusIssue={i => (focused = i.path.nodeId)}
      />
    );
    fireEvent.click(screen.getByText(/oops/));
    expect(focused).toBe('a');
  });

  it('filters by severity when a chip is active', () => {
    render(
      <ValidationPanel
        issues={[
          mkIssue({ id: '1', message: 'big' }),
          mkIssue({ id: '2', severity: 'warning', message: 'small' }),
        ]}
        expanded={true}
        onToggle={() => {}}
        onFocusIssue={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /errors only/i }));
    expect(screen.queryByText('small')).toBeNull();
    expect(screen.queryByText('big')).not.toBeNull();
  });
});
