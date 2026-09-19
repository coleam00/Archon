import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a confirmation holds before the control returns to its resting label. */
export const COPY_CONFIRM_MS = 1800;

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Write text to the clipboard, reporting success rather than throwing.
 *
 * `navigator.clipboard` needs a secure context, so it is absent over plain HTTP
 * and in older browsers. The caller shows a fallback instruction instead of
 * pretending the copy worked — a silent failure is worse than no button.
 *
 * The clipboard is injected so this is testable without a browser.
 */
export async function writeClipboardText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard
): Promise<boolean> {
  if (text.length === 0 || clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The label a copy control shows for its current state.
 *
 * `confirmed` is passed rather than derived, because two controls sit on screen
 * together and the confirmation has to say which scope was taken — one command,
 * or the whole reply.
 */
export function copyLabel(state: CopyState, resting: string, confirmed: string): string {
  if (state === 'copied') return confirmed;
  if (state === 'failed') return 'Press ⌘C';
  return resting;
}

/**
 * Copy-to-clipboard with a self-clearing confirmation.
 *
 * Shared so every copy control in the console behaves identically — same hold,
 * same failure wording — rather than each one inventing its own timing.
 */
export function useCopy(): { state: CopyState; copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback((text: string): void => {
    void (async (): Promise<void> => {
      const ok = await writeClipboardText(text);
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setState('idle');
      }, COPY_CONFIRM_MS);
    })();
  }, []);

  return { state, copy };
}
