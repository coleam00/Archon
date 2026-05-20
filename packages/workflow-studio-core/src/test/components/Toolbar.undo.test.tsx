import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { Toolbar } from '../../components/Toolbar';
import { useBuilderStore } from '../../store/builder-store';
import { useUndoStore } from '../../store/undo-store';
import { PositionProvider } from '../../hooks/PositionContext';
import type { UsePositionPersistence } from '../../hooks/usePositionPersistence';
import type { ReactNode } from 'react';

const mockPositions: UsePositionPersistence = {
  positions: new Map(),
  setPosition: () => {},
  setMany: () => {},
  reset: () => {},
};

function WithPositions({ children }: { children: ReactNode }) {
  return <PositionProvider value={mockPositions}>{children}</PositionProvider>;
}

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
  useUndoStore.setState({ past: [], future: [] });
  useBuilderStore.setState({ nodes: [], positions: {} });
});

describe('Toolbar undo/redo buttons', () => {
  it('undo button tooltip surfaces the next-undo label', () => {
    useUndoStore.setState({
      past: [{ label: 'Align left', nodes: [], workflow: null, positions: {} }],
      future: [],
    });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    expect(getByLabelText('Undo: Align left')).toBeTruthy();
  });

  it('undo button disabled when stack empty', () => {
    useUndoStore.setState({ past: [], future: [] });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    expect(getByLabelText('Undo').hasAttribute('disabled')).toBe(true);
  });

  it('redo button tooltip surfaces the next-redo label', () => {
    useUndoStore.setState({
      past: [],
      future: [{ label: 'Delete nodes', nodes: [], workflow: null, positions: {} }],
    });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    expect(getByLabelText('Redo: Delete nodes')).toBeTruthy();
  });

  it('redo button disabled when future stack empty', () => {
    useUndoStore.setState({ past: [], future: [] });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    expect(getByLabelText('Redo').hasAttribute('disabled')).toBe(true);
  });

  it('undo button enabled when past stack has entries', () => {
    useUndoStore.setState({
      past: [{ label: 'add node', nodes: [], workflow: null, positions: {} }],
      future: [],
    });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    expect(getByLabelText('Undo: add node').hasAttribute('disabled')).toBe(false);
  });

  it('clicking undo button calls applyUndo (pops past stack)', () => {
    const snap = { label: 'add node', nodes: [], workflow: null, positions: {} };
    useUndoStore.setState({ past: [snap], future: [] });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    fireEvent.click(getByLabelText('Undo: add node'));
    // After undo, snap moves to future
    const { past, future } = useUndoStore.getState();
    expect(past.length).toBe(0);
    expect(future.length).toBe(1);
    expect(future[0].label).toBe('add node');
  });

  it('clicking redo button calls applyRedo (pops future stack)', () => {
    const snap = { label: 'add node', nodes: [], workflow: null, positions: {} };
    useUndoStore.setState({ past: [], future: [snap] });
    const { getByLabelText } = render(<Toolbar workflowName="w" onResetLayout={() => {}} />, {
      wrapper: WithPositions,
    });
    fireEvent.click(getByLabelText('Redo: add node'));
    // After redo, snap moves to past
    const { past, future } = useUndoStore.getState();
    expect(past.length).toBe(1);
    expect(past[0].label).toBe('add node');
    expect(future.length).toBe(0);
  });
});
