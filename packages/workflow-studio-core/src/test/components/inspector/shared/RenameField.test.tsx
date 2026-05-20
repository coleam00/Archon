import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RenameField } from '../../../../components/inspector/shared/RenameField';
import { useBuilderStore } from '../../../../store/builder-store';

// happy-dom is registered by tests/setup.ts (preloaded via bunfig.toml).

describe('RenameField', () => {
  beforeEach(() => {
    cleanup();
    useBuilderStore.getState().clearWorkflow();
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'wf', description: '', base: {}, unknown: {} },
      nodes: [
        {
          id: 'classify',
          variant: 'command',
          data: { command: 'classify' },
          base: {},
          unknown: {},
        },
        {
          id: 'review',
          variant: 'command',
          data: { command: 'review' },
          base: { depends_on: ['classify'] },
          unknown: {},
        },
      ],
    });
  });

  it('renames the node and cascades through depends_on', () => {
    render(<RenameField id="classify" />);
    const input = screen.getByLabelText(/node id/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'classify-v2' } });
    fireEvent.blur(input);

    const ids = useBuilderStore.getState().nodes.map(n => n.id);
    expect(ids).toContain('classify-v2');
    const reviewNode = useBuilderStore.getState().nodes.find(n => n.id === 'review')!;
    // depends_on lives in n.base per the actual storage split (see drift notes §2)
    expect(reviewNode.base.depends_on).toEqual(['classify-v2']);
  });

  it('shows a collision error and does not rename', () => {
    render(<RenameField id="classify" />);
    const input = screen.getByLabelText(/node id/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'review' } });
    fireEvent.blur(input);
    expect(screen.getByText(/already exists/i)).toBeDefined();
    const ids = useBuilderStore
      .getState()
      .nodes.map(n => n.id)
      .sort();
    expect(ids).toEqual(['classify', 'review']);
  });

  it('shows an invalid-id error for whitespace input', () => {
    render(<RenameField id="classify" />);
    const input = screen.getByLabelText(/node id/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(screen.getByText(/invalid id/i)).toBeDefined();
  });

  it('shows an invalid-id error for illegal characters', () => {
    render(<RenameField id="classify" />);
    const input = screen.getByLabelText(/node id/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1starts-with-digit' } });
    fireEvent.blur(input);
    expect(screen.getByText(/invalid id/i)).toBeDefined();
  });

  it('no-op when draft equals current id (no error, no store mutation)', () => {
    render(<RenameField id="classify" />);
    const input = screen.getByLabelText(/node id/i) as HTMLInputElement;
    fireEvent.blur(input);
    const ids = useBuilderStore
      .getState()
      .nodes.map(n => n.id)
      .sort();
    expect(ids).toEqual(['classify', 'review']);
  });
});
