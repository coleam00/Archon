import { useEffect, useCallback } from 'react';

type ShortcutHandler = () => void;

type ShortcutMap = Record<string, ShortcutHandler>;

export function useKeyboardShortcuts(shortcuts: ShortcutMap): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        // Allow Escape even in inputs
        if (e.key !== 'Escape') return;
      }

      const mod = e.metaKey || e.ctrlKey;
      let key = '';

      if (mod && e.key >= '1' && e.key <= '9') {
        key = `mod+${e.key}`;
      } else if (e.key === '/') {
        key = '/';
      } else if (e.key === 'Escape') {
        key = 'Escape';
      }

      if (key && shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
      }
    },
    [shortcuts]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
