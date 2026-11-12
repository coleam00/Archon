import type { ReactElement, ReactNode } from 'react';

/**
 * Shared form primitives for the console settings panels (ModelTiersPanel,
 * AliasesPanel, AssistantConfigPanel, AgentCredentialCard, ModelPickerField).
 *
 * Design v5 (.set-input / .set-select): mono fields on the page surface with a
 * magenta focus ring. Tokens only — colors come from the console theme vars.
 */

/** Free-text field (design v5 .set-input). */
export const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface px-3.5 py-2.75 font-mono text-console-13 text-text-primary placeholder:text-text-tertiary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

/** Row-sized select (tier/alias provider + effort selects). */
export const SELECT_CLASS =
  'w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface-elevated py-2.75 pl-3.5 pr-8 font-mono text-console-13 font-semibold text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

/**
 * Compact select base — the Defaults panel's codex effort / web-search options
 * use it as-is; its assistant/provider pickers reuse it with size overrides
 * (`py-2.75 pl-3.5 text-console-14`) appended.
 */
export const SELECT_CLASS_COMPACT =
  'w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface-elevated py-1.75 pl-3 pr-8 font-mono text-console-13 font-semibold text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

/**
 * Relative wrapper that overlays the design chevron on an appearance-none
 * select (.set-select / .set-select-chev — the browser's edge-pinned arrow is
 * killed by appearance-none; this paints the design's chevron at right:11px).
 */
export function SelectShell({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      {children}
      <span aria-hidden className="pointer-events-none absolute right-2.75 flex text-text-tertiary">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </span>
  );
}
