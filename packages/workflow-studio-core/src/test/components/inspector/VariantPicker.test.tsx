import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VariantPicker } from '../../../components/inspector/general/VariantPicker';
import { useBuilderStore } from '../../../store/builder-store';

// Note: The task spec used 'agent' as a target variant but 'agent' is not a
// valid VariantId in this codebase. Tests use 'command' instead.

describe('<VariantPicker>', () => {
  beforeEach(() => {
    cleanup();
    useBuilderStore.setState({
      nodes: [{ id: 'a', variant: 'bash', data: {}, base: {}, unknown: {} } as any],
      selectedNodeIds: ['a'],
      primarySelectionId: 'a',
    });
  });
  afterEach(() => {
    cleanup();
    useBuilderStore.setState({ nodes: [], selectedNodeIds: [], primarySelectionId: null });
  });

  it('renders the current variant as the trigger label', () => {
    const { getByRole } = render(<VariantPicker />);
    expect((getByRole('combobox') as HTMLSelectElement).value).toBe('bash');
  });

  it('selecting a different variant opens a confirm modal', () => {
    const { getByRole } = render(<VariantPicker />);
    const select = getByRole('combobox');
    fireEvent.change(select, { target: { value: 'command' } });
    expect(getByRole('dialog')).toBeTruthy();
  });

  it('canceling the modal is a no-op (variant unchanged)', () => {
    const { getByRole } = render(<VariantPicker />);
    fireEvent.change(getByRole('combobox'), { target: { value: 'command' } });
    // Use button role to disambiguate from the 'cancel' <option> in the select
    fireEvent.click(getByRole('button', { name: /cancel/i }));
    expect(useBuilderStore.getState().nodes[0].variant).toBe('bash');
  });

  it('confirming calls convertVariant', () => {
    const { getByRole } = render(<VariantPicker />);
    fireEvent.change(getByRole('combobox'), { target: { value: 'command' } });
    // Use button role to disambiguate from potential text matches
    fireEvent.click(getByRole('button', { name: /convert/i }));
    expect(useBuilderStore.getState().nodes[0].variant).toBe('command');
  });
});
