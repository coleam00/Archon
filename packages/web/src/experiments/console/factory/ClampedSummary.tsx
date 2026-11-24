import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';

/** Tailwind sees whole class names only, so each clamp is written out. */
const CLAMP = { 1: 'line-clamp-1', 2: 'line-clamp-2', 3: 'line-clamp-3' } as const;

/**
 * A paragraph clamped to `lines` lines at every width, with a More toggle: the factory's
 * summary at two lines, so the numbers sit high in the Overview's first screen, and an ask's
 * context at three (Visual standard, rule 9), and a setting's description at one (owner change 6
 * of 2026-11-21). Line breaks in the
 * text are kept. The toggle shows only when it does something: while expanded, or when the
 * clamped text overflows, measured on mount and on every resize.
 */
export function ClampedSummary({ text, lines }: { text: string; lines: 1 | 2 | 3 }): ReactElement {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="flex min-w-0 max-w-3xl flex-col items-start gap-1">
      <p
        ref={ref}
        className={`whitespace-pre-line text-console-14 leading-relaxed text-text-secondary [overflow-wrap:anywhere] ${
          expanded ? '' : CLAMP[lines]
        }`}
      >
        {text}
      </p>
      {expanded || overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="rounded text-console-13 font-medium text-text-tertiary transition-colors duration-150 ease-out hover:text-text-primary"
        >
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}
