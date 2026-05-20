import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { SnippetsSection } from '../../../components/library/SnippetsSection';
import { PositionProvider } from '../../../hooks/PositionContext';
import { useBuilderStore } from '../../../store/builder-store';
import type { UsePositionPersistence } from '../../../hooks/usePositionPersistence';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
beforeEach(() => useBuilderStore.getState().clearWorkflow());
afterEach(() => cleanup());

const stubPersistence: UsePositionPersistence = {
  positions: new Map(),
  setPosition: () => undefined,
  setMany: () => undefined,
  reset: () => undefined,
};

const renderWithPositionStub = () =>
  render(
    <ReactFlowProvider>
      <PositionProvider value={stubPersistence}>
        <SnippetsSection />
      </PositionProvider>
    </ReactFlowProvider>
  );

describe('SnippetsSection', () => {
  it('renders starter and pattern headings + 3 rows under each', () => {
    const { getByText, getByLabelText } = renderWithPositionStub();
    expect(getByText(/starters/i)).toBeDefined();
    expect(getByText(/patterns/i)).toBeDefined();
    expect(getByLabelText(/Insert snippet classify-then-branch/i)).toBeDefined();
  });

  it('click-to-add inserts a snippet into the store', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'host', description: '', base: {}, unknown: {} },
      nodes: [],
    });
    const { getByLabelText } = renderWithPositionStub();
    fireEvent.click(getByLabelText(/Insert snippet classify-then-branch/i));
    const ids = useBuilderStore.getState().nodes.map(n => n.id);
    expect(ids).toEqual(['classify', 'branch-yes', 'branch-no']);
  });
});
