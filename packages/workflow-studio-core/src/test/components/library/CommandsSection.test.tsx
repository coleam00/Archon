import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ApiClientProvider } from '../../../api/ApiClientProvider';
import { CommandsSection } from '../../../components/library/CommandsSection';
import { useBuilderStore } from '../../../store/builder-store';
import type { WorkflowApiClient } from '../../../api/WorkflowApiClient';
import { LIBRARY_DRAG_MIME, decodeLibraryDrag } from '../../../components/library/dragPayload';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
beforeEach(() => useBuilderStore.getState().clearWorkflow());
afterEach(() => cleanup());

type CommandRow = { name: string; source: 'project' | 'global' | 'bundled' };

const mkClient = (cmds: CommandRow[]): WorkflowApiClient => ({
  ping: async () => ({ ok: true }),
  listCodebases: async () => null,
  listWorkflows: async () => [],
  listCommands: async (_cwd: string) => cmds,
  listProviders: async () => [],
  getWorkflow: async () => ({ name: '', description: '', nodes: [] }) as never,
  saveWorkflow: async (_n, _c, d) => d,
  deleteWorkflow: async () => undefined,
  validateWorkflow: async () => ({ valid: true }),
});

function renderWith(client: WorkflowApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <CommandsSection cwd="/abs/path/test-cwd" />
      </ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('CommandsSection', () => {
  it('renders one row per command from listCommands, showing name + source subtitle', async () => {
    const { getByText } = renderWith(
      mkClient([
        { name: 'classify', source: 'project' },
        { name: 'review', source: 'bundled' },
      ])
    );
    await waitFor(() => expect(getByText('classify')).toBeDefined());
    expect(getByText('review')).toBeDefined();
    expect(getByText(/project/i)).toBeDefined();
    expect(getByText(/bundled/i)).toBeDefined();
  });

  it('click-to-add appends a command node with prefilled command + scoped id hint', async () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: '', base: {}, unknown: {} },
      nodes: [],
    });
    const { getByText, getByLabelText } = renderWith(
      mkClient([{ name: 'classify', source: 'project' }])
    );
    await waitFor(() => expect(getByText('classify')).toBeDefined());
    fireEvent.click(getByLabelText('Add command running classify'));
    const nodes = useBuilderStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].variant).toBe('command');
    expect(nodes[0].id).toBe('run-classify');
    expect(nodes[0].data).toMatchObject({ command: 'classify' });
  });

  it('renders an empty-state message when listCommands returns []', async () => {
    const { getByText } = renderWith(mkClient([]));
    await waitFor(() => expect(getByText(/no commands/i)).toBeDefined());
  });

  it('drag-from-row emits idHintOverride + prefill so the dropped node uses run-<name>', async () => {
    const { getByText, getByLabelText } = renderWith(
      mkClient([{ name: 'classify', source: 'project' }])
    );
    await waitFor(() => expect(getByText('classify')).toBeDefined());

    // Mock dataTransfer (happy-dom doesn't provide one for synthetic events).
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (k: string, v: string) => {
        data[k] = v;
      },
      getData: (k: string) => data[k] ?? '',
      types: [] as string[],
    };
    fireEvent.dragStart(getByLabelText('Add command running classify'), { dataTransfer });

    const decoded = decodeLibraryDrag(data[LIBRARY_DRAG_MIME]);
    expect(decoded).toEqual({
      kind: 'variant',
      variantId: 'command',
      idHintOverride: 'run-classify',
      prefill: { command: 'classify' },
    });
  });
});
