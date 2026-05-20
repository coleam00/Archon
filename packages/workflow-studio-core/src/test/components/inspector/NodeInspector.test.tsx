import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NodeInspector } from '../../../components/inspector/NodeInspector';
import { useBuilderStore } from '../../../store/builder-store';

const seedTwoVariants = () => {
  useBuilderStore.getState().loadWorkflow({
    meta: { name: 'wf', description: '', base: {}, unknown: {} },
    nodes: [
      { id: 'n-cmd', variant: 'command', data: { command: 'classify' }, base: {}, unknown: {} },
      { id: 'n-bash', variant: 'bash', data: { bash: 'echo hi' }, base: {}, unknown: {} },
    ],
  });
};

describe('NodeInspector', () => {
  beforeEach(() => {
    cleanup();
    useBuilderStore.getState().clearWorkflow();
  });

  it('renders the empty state when no node is selected', () => {
    render(<NodeInspector />);
    expect(screen.getByText(/select a node/i)).toBeDefined();
  });

  it('renders all 7 tabs for command (AI-honoring)', () => {
    seedTwoVariants();
    useBuilderStore.getState().setSelection(['n-cmd']);
    render(<NodeInspector />);
    for (const tab of [
      'General',
      'Execution',
      'Provider',
      'Tools',
      'Hooks',
      'Skills+MCP',
      'Advanced',
    ]) {
      expect(
        screen.getByRole('tab', { name: new RegExp(tab.replace('+', '\\+'), 'i') })
      ).toBeDefined();
    }
  });

  it('renders General + Execution + Advanced only for bash (no AI tabs)', () => {
    seedTwoVariants();
    useBuilderStore.getState().setSelection(['n-bash']);
    render(<NodeInspector />);
    expect(screen.getByRole('tab', { name: /general/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /execution/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /advanced/i })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /provider/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^tools$/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /hooks/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /skills/i })).toBeNull();
  });

  it('switches tab content on click', () => {
    seedTwoVariants();
    useBuilderStore.getState().setSelection(['n-cmd']);
    render(<NodeInspector />);
    fireEvent.click(screen.getByRole('tab', { name: /advanced/i }));
    expect(screen.getByTestId('tab-panel-advanced')).toBeDefined();
  });

  it('shows the variant pill in the header', () => {
    seedTwoVariants();
    useBuilderStore.getState().setSelection(['n-cmd']);
    render(<NodeInspector />);
    expect(screen.getByTitle('Variant').textContent).toBe('command');
  });

  it('renders the per-variant General Inspector body (Command field for command variant)', () => {
    seedTwoVariants();
    useBuilderStore.getState().setSelection(['n-cmd']);
    render(<NodeInspector />);
    // General is the active tab on mount; CommandInspector renders a Command field.
    expect(screen.getByLabelText(/^command$/i)).toBeDefined();
  });
});
