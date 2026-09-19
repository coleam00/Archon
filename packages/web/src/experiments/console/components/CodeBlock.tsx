import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/** How long the confirmation holds before the button returns to "Copy". */
const CONFIRM_MS = 1800;

/** `language-bash` → `bash`. Unknown or absent leaves the label empty. */
function languageOf(children: ReactNode): string {
  if (!isValidElement<{ className?: string }>(children)) return '';
  const cls = children.props.className ?? '';
  const match = /language-([\w+-]+)/.exec(cls);
  return match?.[1] ?? '';
}

/**
 * A fenced code block with a one-click copy.
 *
 * The header bar is always visible rather than revealed on hover: a hover-only
 * control does not exist on touch, and is invisible to anyone who has not
 * already learned it is there. This is a console — taking the command and
 * running it is the point, so the affordance should not be a secret.
 *
 * Copies `textContent` from the rendered element rather than reconstructing the
 * source. Syntax highlighting wraps the code in spans, so anything that walks
 * the React children risks pasting markup; the DOM already holds exactly the
 * text the user can see.
 */
export function CodeBlock({ children }: { children?: ReactNode }): ReactElement {
  const preRef = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const language = languageOf(children);

  useEffect((): (() => void) => {
    return (): void => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const copy = (): void => {
    const text = preRef.current?.textContent ?? '';
    if (text.length === 0) return;
    void (async (): Promise<void> => {
      let ok = false;
      try {
        // Requires a secure context; absent on plain HTTP and older browsers.
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setState('idle');
      }, CONFIRM_MS);
    })();
  };

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Press ⌘C' : 'Copy';

  return (
    <div className="my-2">
      <div
        className="flex items-center justify-between rounded-t-[8px] border border-b-0 bg-surface-elevated px-2.5 py-1 font-mono text-[10.5px] text-text-tertiary"
        style={{ borderColor: 'var(--border)' }}
      >
        <span>{language}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${language === '' ? 'code' : language} block`}
          className={`flex items-center gap-1.5 rounded-[6px] border px-[7px] py-[2px] transition-colors ${
            state === 'copied' ? 'text-success' : 'text-text-secondary hover:text-text-primary'
          }`}
          style={{
            borderColor:
              state === 'copied'
                ? 'color-mix(in oklch, var(--success), transparent 55%)'
                : 'var(--border-bright)',
          }}
        >
          <span aria-hidden>{state === 'copied' ? '✓' : '⧉'}</span>
          {label}
        </button>
      </div>
      {/*
        Announced rather than shown only in colour: the confirmation is the
        whole feedback loop, and a visual-only one leaves screen-reader users
        clicking with no idea whether it worked.
      */}
      <span aria-live="polite" className="sr-only">
        {state === 'copied' ? 'Copied to clipboard' : ''}
      </span>
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-b-[8px] border bg-surface-inset p-2 text-[12px] leading-relaxed"
        style={{ borderColor: 'var(--border)' }}
      >
        {children}
      </pre>
    </div>
  );
}
