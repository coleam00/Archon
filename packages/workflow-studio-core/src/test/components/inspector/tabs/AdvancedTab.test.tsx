import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AdvancedTab } from '../../../../components/inspector/tabs/AdvancedTab';
import { useBuilderStore } from '../../../../store/builder-store';

const seedNode = () => {
  useBuilderStore.getState().clearWorkflow();
  useBuilderStore.getState().loadWorkflow({
    meta: { name: 'wf', description: '', base: {}, unknown: {} },
    nodes: [
      {
        id: 'n1',
        variant: 'command',
        data: { command: 'classify', _unknown: { stash: 'value' } } as never,
        base: {},
        unknown: { topLevelExtra: 1 },
      },
    ],
  });
};

const renderTab = (id: string) => {
  const node = useBuilderStore.getState().nodes.find(n => n.id === id);
  if (!node) throw new Error('seed first');
  return render(
    <AdvancedTab
      id={id}
      data={node.data}
      base={node.base}
      unknown={node.unknown}
      onChange={p => useBuilderStore.getState().updateNodeData(id, p)}
      siblingIds={[]}
    />
  );
};

describe('AdvancedTab', () => {
  beforeEach(() => cleanup());

  it('renders both raw-fields editors and the capabilities readout', () => {
    seedNode();
    renderTab('n1');
    expect(screen.getByLabelText(/variant raw fields/i)).toBeDefined();
    expect(screen.getByLabelText(/top-level raw fields/i)).toBeDefined();
    expect(screen.getByText(/variant capabilities/i)).toBeDefined();
    expect(screen.getByText(/honorsAiFields/i)).toBeDefined();
  });

  it('writes data._unknown via store.updateNode (not the routed updateNodeData)', () => {
    seedNode();
    renderTab('n1');
    const ta = screen.getByLabelText(/variant raw fields/i) as HTMLTextAreaElement;
    expect(ta.value).toContain('"stash": "value"');
    fireEvent.change(ta, { target: { value: '{"newKey": 123}' } });
    fireEvent.blur(ta);
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect((node.data as { _unknown?: Record<string, unknown> })._unknown).toEqual({
      newKey: 123,
    });
    // Should NOT have leaked to n.unknown.
    expect(node.unknown).toEqual({ topLevelExtra: 1 });
  });

  it('writes top-level n.unknown via the standard onChange/updateNodeData path', () => {
    seedNode();
    renderTab('n1');
    const ta = screen.getByLabelText(/top-level raw fields/i) as HTMLTextAreaElement;
    expect(ta.value).toContain('"topLevelExtra": 1');
    fireEvent.change(ta, { target: { value: '{"topLevelExtra": 2, "added": "yes"}' } });
    fireEvent.blur(ta);
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.unknown).toEqual({ topLevelExtra: 2, added: 'yes' });
  });
});
