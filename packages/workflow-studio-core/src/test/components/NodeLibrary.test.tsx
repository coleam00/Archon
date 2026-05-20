import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { NodeLibrary } from '../../components/NodeLibrary';
import { ApiClientProvider } from '../../api/ApiClientProvider';
import { PositionProvider } from '../../hooks/PositionContext';
import { useBuilderStore } from '../../store/builder-store';
import { LIBRARY_DRAG_MIME, decodeLibraryDrag } from '../../components/library/dragPayload';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';
import type { UsePositionPersistence } from '../../hooks/usePositionPersistence';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

beforeEach(() => useBuilderStore.getState().clearWorkflow());
afterEach(() => cleanup());

// Stub client used purely so CommandsSection (rendered by NodeLibrary) doesn't
// crash when these tests mount the library. The library tests don't care about
// commands — they just need the providers to be present.
const stubClient: WorkflowApiClient = {
  ping: async () => ({ ok: true }),
  listCodebases: async () => null,
  listWorkflows: async () => [],
  listCommands: async () => [],
  listProviders: async () => [],
  getWorkflow: async () => ({ name: '', description: '', nodes: [] }) as never,
  saveWorkflow: async (_n, _c, d) => d,
  deleteWorkflow: async () => undefined,
  validateWorkflow: async () => ({ valid: true }),
};

const stubPersistence: UsePositionPersistence = {
  positions: new Map(),
  setPosition: () => undefined,
  setMany: () => undefined,
  reset: () => undefined,
};

function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={stubClient}>
        <ReactFlowProvider>
          <PositionProvider value={stubPersistence}>
            <NodeLibrary cwd="/abs/path/test-cwd" />
          </PositionProvider>
        </ReactFlowProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('NodeLibrary', () => {
  it('renders one tile per variant under the Variants heading', () => {
    const { getByRole, getByLabelText } = renderLibrary();
    expect(getByRole('heading', { name: /variants/i })).toBeDefined();
    for (const v of ['command', 'prompt', 'bash', 'script', 'loop', 'approval', 'cancel']) {
      expect(getByLabelText(`Add ${v} node`)).toBeDefined();
    }
  });

  it('click-to-add appends a node via addNodeFromVariant', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: '', base: {}, unknown: {} },
      nodes: [],
    });
    const { getByLabelText } = renderLibrary();
    fireEvent.click(getByLabelText('Add loop node'));
    const nodes = useBuilderStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].variant).toBe('loop');
  });

  it('emits a variant drag payload via dataTransfer on tile drag', () => {
    const { getByLabelText } = renderLibrary();
    const tile = getByLabelText('Add command node');
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (k: string, v: string) => {
        data[k] = v;
      },
      getData: (k: string) => data[k] ?? '',
      types: [] as string[],
    };
    fireEvent.dragStart(tile, { dataTransfer });
    expect(decodeLibraryDrag(data[LIBRARY_DRAG_MIME])).toEqual({
      kind: 'variant',
      variantId: 'command',
    });
  });
});
