import { useEffect, useCallback } from 'react';

interface BuilderKeyboardActions {
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleLibrary: () => void;
  onToggleYaml: () => void;
  onToggleValidation: () => void;
  onAddPrompt: () => void;
  onAddBash: () => void;
  onDeleteSelected: () => void;
  onDuplicateSelected: () => void;
  onQuickAdd?: () => void;
  onFitView?: () => void;
  onSelectAll?: () => void;
}

function isInputTarget(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement).tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (e.target as HTMLElement).isContentEditable
  );
}

export function useBuilderKeyboard(actions: BuilderKeyboardActions, enabled = true): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      const mod = e.metaKey || e.ctrlKey;
      const inInput = isInputTarget(e);

      // --- Always-active shortcuts (even in inputs) ---
      if (mod) {
        if (e.key === 's') {
          e.preventDefault();
          actions.onSave();
          return;
        }
        if (e.key === 'z' && e.shiftKey) {
          e.preventDefault();
          actions.onRedo();
          return;
        }
        if (e.key === 'z') {
          e.preventDefault();
          actions.onUndo();
          return;
        }
        if (e.key === '\\') {
          e.preventDefault();
          actions.onToggleLibrary();
          return;
        }
        if (e.key === 'j') {
          e.preventDefault();
          actions.onToggleYaml();
          return;
        }
        if (e.key === '.') {
          e.preventDefault();
          actions.onToggleValidation();
          return;
        }
      }

      // --- Only when NOT in input/textarea ---
      if (inInput) return;

      if (mod) {
        if (e.key === 'd') {
          e.preventDefault();
          actions.onDuplicateSelected();
          return;
        }
        if (e.key === '0') {
          e.preventDefault();
          actions.onFitView?.();
          return;
        }
        if (e.key === 'a') {
          e.preventDefault();
          actions.onSelectAll?.();
          return;
        }
      }

      // Single-key shortcuts
      switch (e.key) {
        case 'n':
          actions.onQuickAdd?.();
          break;
        case 'p':
          actions.onAddPrompt();
          break;
        case 'b':
          actions.onAddBash();
          break;
        case 'Delete':
        case 'Backspace':
          actions.onDeleteSelected();
          break;
        case 'f':
          actions.onFitView?.();
          break;
      }
    },
    [actions, enabled]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
