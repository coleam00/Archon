import { useEffect, type ReactElement } from 'react';
import { formatChord, type KeyEntry } from '../lib/keymap';

interface KeymapHelpProps {
  open: boolean;
  onClose: () => void;
  groups: readonly KeymapGroup[];
}

export type HelpEntry = KeyEntry;

export interface KeymapGroup {
  title: string;
  entries: readonly HelpEntry[];
}

/**
 * `?` overlay — reads the same binding tables the dispatcher consumes so
 * the documented chords can never drift from the wired ones.
 */
export function KeymapHelp({ open, onClose, groups }: KeymapHelpProps): ReactElement | null {
  // Local Escape/? handler — the global keymap is suppressed while this
  // overlay is open (so shortcuts don't compose with dialogs), which means
  // we have to dismiss it ourselves.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={e => {
          e.stopPropagation();
        }}
        className="w-full max-w-lg overflow-hidden rounded-md border border-border bg-surface-elevated shadow-2xl"
      >
        <header className="flex items-baseline justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">Keyboard shortcuts</h2>
          <span className="font-mono text-[10px] text-text-tertiary">esc · ?</span>
        </header>
        <div className="max-h-[70vh] overflow-y-auto">
          {groups.map(group => (
            <section key={group.title} className="border-b border-border last:border-b-0">
              <h3 className="px-4 pt-3 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                {group.title}
              </h3>
              <ul className="pb-2">
                {group.entries.map(e => (
                  <li
                    key={`${group.title}:${e.keys.join('+')}:${e.label}`}
                    className="flex items-baseline justify-between gap-4 px-4 py-1.5"
                  >
                    <span className="text-[13px] text-text-secondary">{e.label}</span>
                    <kbd className="shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-primary">
                      {formatChord(e.keys)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
