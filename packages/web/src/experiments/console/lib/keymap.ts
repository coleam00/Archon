/**
 * Console keymap — neovim-flavored, light-modal.
 *
 * "Light-modal" means: bindings fire whenever the user isn't typing in an
 * input/textarea/contentEditable, with no NORMAL/INSERT indicator. The
 * activeElement guard mirrors the pattern DraftRunCard's window listener
 * already uses; we lift it here so every binding shares one place to
 * decide "is the user trying to type something."
 *
 * Two-key chords (gg) are supported via a 500ms buffer:
 *   - first matching prefix arms the buffer
 *   - second key within the window resolves the chord
 *   - any non-matching key or timeout clears it
 *
 * Bindings declare their own `when:` predicate when they should be gated
 * (e.g. approval shortcuts only on paused runs). The `?` help overlay is
 * driven by a separate static catalogue (lib/shortcuts.ts) — drift is
 * possible and the cost of the occasional desync is lower than a registry
 * system that obscures the wiring.
 *
 * Each useKeymap call owns its own chord buffer. Today multiple buffers
 * coexist (ConsoleApp + the active route) without collision because no
 * prefix keys overlap across them; if a future binding adds a chord
 * starting with `g`, `p`, `n`, or `?`, the chord buffers must be unified
 * (e.g. lifted into a context) before that ships.
 */

import { useEffect } from 'react';

/**
 * Shared shape for a chord + its human label. `Binding` (this file) is the
 * dispatcher-side record; `HelpEntry` (KeymapHelp.tsx) is the docs-side
 * record; both extend `KeyEntry` so the chord/label shape can't drift.
 */
export interface KeyEntry {
  /**
   * Single key or chord. Match is exact-equal across the chord buffer.
   * Non-empty by construction: `readonly [string, ...string[]]` rejects
   * `keys: []` at the type level (a no-op binding would otherwise be
   * silently dropped by the prefix matcher).
   */
  keys: readonly [string, ...string[]];
  /** Human-readable label for the help overlay. */
  label: string;
}

export interface Binding extends KeyEntry {
  run: () => void;
  /** Optional gate. When it returns false the binding is invisible to both
   *  the dispatcher and the help overlay. */
  when?: () => boolean;
}

interface UseKeymapOptions {
  bindings: readonly Binding[];
  /**
   * Coarse-grained gate the caller controls (e.g. "a dialog I own is
   * open"). When false, the effect never registers the window listener.
   * Separate from {@link modalIsOpen}, which is a DOM-scan fallback that
   * fires on every keystroke — `enabled: false` is cheaper when the
   * caller already tracks the gating state, `modalIsOpen()` is the safety
   * net for route-level keymaps that don't know about every modal.
   */
  enabled?: boolean;
}

const CHORD_TIMEOUT_MS = 500;

function defaultInputGuard(): boolean {
  if (typeof document === 'undefined') return false;
  const target = document.activeElement as HTMLElement | null;
  if (target === null) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (target.isContentEditable) return false;
  return true;
}

/**
 * Returns true when an open modal dialog is in the DOM.
 *
 * Why this exists: route-level useKeymap callers (RunsPage, RunDetailPage)
 * don't know which dialogs the shell may have open, so the input-focus
 * guard alone is not enough — there are paint frames between "dialog
 * mounted" and "dialog's input focused" where a fast keystroke would hit
 * the route binding underneath instead of the dialog. Scanning for any
 * `[role="dialog"][aria-modal="true"]` closes that race generically, at
 * the cost of one querySelector per keydown.
 */
function modalIsOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (prefix[i] !== full[i]) return false;
  return true;
}

export function useKeymap({ bindings, enabled = true }: UseKeymapOptions): void {
  useEffect(() => {
    if (!enabled) return;

    let buffer: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reset = (): void => {
      buffer = [];
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const handler = (e: KeyboardEvent): void => {
      // Modifier keys are NOT part of our chord vocabulary. Cmd/Ctrl/Alt
      // combos bypass the keymap entirely so browser shortcuts (Cmd+R,
      // Cmd+K-from-extensions, etc.) keep working.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!defaultInputGuard()) return;
      // Suppress route-level bindings while any modal dialog is open so
      // Enter/Escape inside a palette doesn't double-fire into the page
      // underneath. The dialog component itself handles its own keys
      // explicitly (palette listens on its input, help listens on window).
      if (modalIsOpen()) return;

      // Ignore standalone modifier keypresses (Shift, etc.) so chords don't
      // see them as separate steps.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;

      const next = [...buffer, e.key];

      const exact = bindings.find(b => arraysEqual(b.keys, next) && (b.when ? b.when() : true));
      if (exact !== undefined) {
        e.preventDefault();
        reset();
        exact.run();
        return;
      }

      const prefix = bindings.find(b => isPrefix(next, b.keys) && (b.when ? b.when() : true));
      if (prefix !== undefined) {
        e.preventDefault();
        buffer = next;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(reset, CHORD_TIMEOUT_MS);
        return;
      }

      // No exact, no prefix — clear the buffer (this key wasn't part of any
      // chord) and let the event continue. We deliberately don't call
      // preventDefault so unrelated keys still reach inputs that may be
      // focused on the next tick.
      reset();
    };

    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
      reset();
    };
  }, [bindings, enabled]);
}

/** Pretty-format a chord for the help overlay. */
export function formatChord(keys: readonly string[]): string {
  return keys
    .map(k => {
      if (k === ' ') return 'Space';
      if (k === 'Escape') return 'Esc';
      if (k === 'Enter') return '↵';
      if (k === 'ArrowUp') return '↑';
      if (k === 'ArrowDown') return '↓';
      return k;
    })
    .join(' ');
}
