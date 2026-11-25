import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * The frame of the sidebar's Factory pages: a header in the console's shape (the page title
 * and at most one meta line under it; a pack has one page, How it works, so no tabs), then the
 * page. The header stays short, so How it works keeps its root view in the first screen at
 * 1440x900. Where the page was read from is a detail, not a line of the header: a quiet
 * "Source" toggle beside the title opens it.
 */
export function PackFrame({
  title,
  titleHint,
  subtitle,
  source,
  actions,
  children,
}: {
  title: ReactNode;
  /** The title's hover text: the raw id a readable title stands for. */
  titleHint?: string;
  subtitle?: ReactNode;
  /** Where the page was read from, behind the Source toggle. */
  source?: ReactNode;
  /** A control at the right of the title row, such as which map to draw. */
  actions?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceId = useId();
  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <h1
              title={titleHint}
              className="min-w-0 truncate text-console-22 font-semibold tracking-console-heading text-text-primary"
            >
              {title}
            </h1>
            {source === undefined ? null : (
              <button
                type="button"
                aria-expanded={sourceOpen}
                aria-controls={sourceId}
                onClick={() => {
                  setSourceOpen(open => !open);
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded text-console-12 text-text-tertiary transition-colors duration-150 ease-out hover:text-text-secondary"
              >
                <Info aria-hidden="true" className="size-4" />
                Source
              </button>
            )}
            {actions === undefined ? null : <div className="ml-auto shrink-0">{actions}</div>}
          </div>
          {subtitle === undefined ? null : (
            <div className="truncate text-console-13 text-text-tertiary">{subtitle}</div>
          )}
          {source === undefined || !sourceOpen ? null : (
            <p
              id={sourceId}
              className="min-w-0 text-console-13 text-text-tertiary [overflow-wrap:anywhere]"
            >
              {source}
            </p>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6">{children}</div>
      </div>
    </section>
  );
}
