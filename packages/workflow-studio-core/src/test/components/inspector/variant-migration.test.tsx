import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { NodeInspector } from '../../../components/inspector/NodeInspector';
import { useBuilderStore } from '../../../store/builder-store';

/**
 * Phase 4 §12.2 deliverable. Drives convertVariant through the store and
 * asserts:
 *   (a) the inspector re-derives its tab list when capabilities change;
 *   (b) base fields the target keeps survive (e.g. depends_on);
 *   (c) AI base fields are parked into data._unknown._converted_from when
 *       the target has honorsAiFields=false (drift §4 + commit 87ff737);
 *   (d) the AdvancedTab renders the migrated _unknown bag so a future
 *       convert-back can recover it.
 */

const seedCommandNodeWithAi = () => {
  useBuilderStore.getState().clearWorkflow();
  useBuilderStore.getState().loadWorkflow({
    meta: { name: 'wf', description: '', base: {}, unknown: {} },
    nodes: [
      {
        id: 'n1',
        variant: 'command',
        data: { command: 'classify' } as never,
        base: {
          depends_on: ['upstream'],
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          allowed_tools: ['Read'],
        },
        unknown: {},
      },
    ],
  });
  useBuilderStore.getState().setSelection(['n1']);
};

describe('variant migration via convertVariant', () => {
  beforeEach(() => cleanup());

  it('inspector re-derives tab list when variant changes from AI to non-AI', () => {
    seedCommandNodeWithAi();
    const { rerender } = render(<NodeInspector />);
    expect(screen.getByRole('tab', { name: /provider/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /^tools$/i })).toBeDefined();

    act(() => {
      useBuilderStore.getState().convertVariant('n1', 'bash');
    });
    rerender(<NodeInspector />);

    expect(screen.queryByRole('tab', { name: /provider/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^tools$/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /general/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /execution/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /advanced/i })).toBeDefined();
  });

  it('flow-control base fields (depends_on) survive migration to bash', () => {
    seedCommandNodeWithAi();
    act(() => {
      useBuilderStore.getState().convertVariant('n1', 'bash');
    });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.variant).toBe('bash');
    expect(node.base.depends_on).toEqual(['upstream']);
  });

  it('AI base fields are parked into data._unknown._converted_from when target has honorsAiFields=false', () => {
    seedCommandNodeWithAi();
    act(() => {
      useBuilderStore.getState().convertVariant('n1', 'bash');
    });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.base.provider).toBeUndefined();
    expect(node.base.model).toBeUndefined();
    expect(node.base.allowed_tools).toBeUndefined();

    const dataUnknown = (node.data as { _unknown?: Record<string, unknown> })._unknown ?? {};
    const convertedFrom = dataUnknown._converted_from as Record<string, unknown>;
    expect(convertedFrom).toBeDefined();
    expect(convertedFrom.variant).toBe('command');
    expect(convertedFrom.provider).toBe('anthropic');
    expect(convertedFrom.model).toBe('claude-opus-4-7');
    expect(convertedFrom.allowed_tools).toEqual(['Read']);
  });

  it('AdvancedTab renders the migrated _unknown bag with _converted_from visible', () => {
    seedCommandNodeWithAi();
    act(() => {
      useBuilderStore.getState().convertVariant('n1', 'bash');
    });
    render(<NodeInspector />);
    fireEvent.click(screen.getByRole('tab', { name: /advanced/i }));
    const ta = screen.getByLabelText(/variant raw fields/i) as HTMLTextAreaElement;
    expect(ta.value).toContain('_converted_from');
    expect(ta.value).toContain('"variant": "command"');
    expect(ta.value).toContain('"provider": "anthropic"');
  });
});
