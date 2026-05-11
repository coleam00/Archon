import { describe, test, expect, mock, beforeEach } from 'bun:test';
import {
  handleBuilderKeydown,
  isInputTarget,
  type BuilderKeyboardActions,
} from './useBuilderKeyboard';

function makeActions(): BuilderKeyboardActions & {
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const bump = (name: string): (() => void) => {
    return (): void => {
      calls[name] = (calls[name] ?? 0) + 1;
    };
  };
  return {
    calls,
    onSave: bump('onSave'),
    onUndo: bump('onUndo'),
    onRedo: bump('onRedo'),
    onToggleLibrary: bump('onToggleLibrary'),
    onToggleYaml: bump('onToggleYaml'),
    onToggleValidation: bump('onToggleValidation'),
    onAddPrompt: bump('onAddPrompt'),
    onAddBash: bump('onAddBash'),
    onDeleteSelected: bump('onDeleteSelected'),
    onDuplicateSelected: bump('onDuplicateSelected'),
    onQuickAdd: bump('onQuickAdd'),
    onFitView: bump('onFitView'),
    onSelectAll: bump('onSelectAll'),
  };
}

function makeEvent(
  key: string,
  target: { tagName?: string; isContentEditable?: boolean; role?: string } | null
): KeyboardEvent {
  const el =
    target === null
      ? null
      : ({
          tagName: target.tagName ?? 'DIV',
          isContentEditable: target.isContentEditable ?? false,
          getAttribute: (name: string): string | null =>
            name === 'role' ? (target.role ?? null) : null,
        } as unknown as HTMLElement);
  return {
    key,
    target: el,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    preventDefault: mock(() => {}),
  } as unknown as KeyboardEvent;
}

describe('isInputTarget', () => {
  test('returns true for INPUT, TEXTAREA, SELECT', () => {
    expect(isInputTarget(makeEvent('a', { tagName: 'INPUT' }))).toBe(true);
    expect(isInputTarget(makeEvent('a', { tagName: 'TEXTAREA' }))).toBe(true);
    expect(isInputTarget(makeEvent('a', { tagName: 'SELECT' }))).toBe(true);
  });

  test('returns true for contentEditable elements', () => {
    expect(isInputTarget(makeEvent('a', { tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  test('returns true for ARIA editable roles (combobox, textbox, searchbox)', () => {
    expect(isInputTarget(makeEvent('a', { tagName: 'DIV', role: 'combobox' }))).toBe(true);
    expect(isInputTarget(makeEvent('a', { tagName: 'DIV', role: 'textbox' }))).toBe(true);
    expect(isInputTarget(makeEvent('a', { tagName: 'DIV', role: 'searchbox' }))).toBe(true);
  });

  test('returns false for regular elements without editable role', () => {
    expect(isInputTarget(makeEvent('a', { tagName: 'DIV' }))).toBe(false);
    expect(isInputTarget(makeEvent('a', { tagName: 'BUTTON' }))).toBe(false);
    expect(isInputTarget(makeEvent('a', { tagName: 'DIV', role: 'menu' }))).toBe(false);
  });

  test('returns false when target is null', () => {
    expect(isInputTarget(makeEvent('a', null))).toBe(false);
  });
});

describe('handleBuilderKeydown — delete invariant', () => {
  let actions: ReturnType<typeof makeActions>;

  beforeEach(() => {
    actions = makeActions();
  });

  test('Delete key on canvas triggers onDeleteSelected', () => {
    handleBuilderKeydown(makeEvent('Delete', { tagName: 'DIV' }), actions);
    expect(actions.calls.onDeleteSelected).toBe(1);
  });

  test('Backspace key on canvas triggers onDeleteSelected', () => {
    handleBuilderKeydown(makeEvent('Backspace', { tagName: 'DIV' }), actions);
    expect(actions.calls.onDeleteSelected).toBe(1);
  });

  test('Backspace in INPUT does NOT trigger onDeleteSelected', () => {
    handleBuilderKeydown(makeEvent('Backspace', { tagName: 'INPUT' }), actions);
    expect(actions.calls.onDeleteSelected).toBeUndefined();
  });

  test('Backspace in TEXTAREA does NOT trigger onDeleteSelected', () => {
    handleBuilderKeydown(makeEvent('Backspace', { tagName: 'TEXTAREA' }), actions);
    expect(actions.calls.onDeleteSelected).toBeUndefined();
  });

  test('Backspace in contentEditable does NOT trigger onDeleteSelected', () => {
    handleBuilderKeydown(
      makeEvent('Backspace', { tagName: 'DIV', isContentEditable: true }),
      actions
    );
    expect(actions.calls.onDeleteSelected).toBeUndefined();
  });

  test('Backspace in ARIA combobox does NOT trigger onDeleteSelected', () => {
    handleBuilderKeydown(makeEvent('Backspace', { tagName: 'DIV', role: 'combobox' }), actions);
    expect(actions.calls.onDeleteSelected).toBeUndefined();
  });

  test('Delete in ARIA textbox does NOT trigger onDeleteSelected', () => {
    handleBuilderKeydown(makeEvent('Delete', { tagName: 'DIV', role: 'textbox' }), actions);
    expect(actions.calls.onDeleteSelected).toBeUndefined();
  });

  test('enabled=false suppresses all shortcuts', () => {
    handleBuilderKeydown(makeEvent('Delete', { tagName: 'DIV' }), actions, false);
    handleBuilderKeydown(makeEvent('Backspace', { tagName: 'DIV' }), actions, false);
    expect(actions.calls.onDeleteSelected).toBeUndefined();
  });
});
