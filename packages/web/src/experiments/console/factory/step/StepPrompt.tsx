import { useMemo, useState, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { Panel } from '../document';
import { foldsPrompt } from '../lib/prompt-fold';
import { referenceChips, type ReferenceChip } from '../lib/prompt-references';

const REHYPE_PLUGINS = [rehypeHighlight];

/**
 * A reference chip (`referenceChips`): the input or output by name on an inset pill, the token
 * as written on hover. Any other span is drawn as it is.
 */
const COMPONENTS: Components = {
  span: ({ node: _node, ...props }) => {
    const label = (props as Record<string, unknown>)['data-ref-label'];
    if (typeof label !== 'string') return <span {...props} />;
    return (
      <span
        {...props}
        className="mx-0.5 inline-flex items-baseline rounded-full bg-surface-inset px-2 font-sans text-console-13 not-italic text-text-primary ring-1 ring-inset ring-border"
      />
    );
  },
};

/** Prompt markdown at a readable measure, each reference the server found as a named chip. */
function PromptMarkdown({
  text,
  chips,
  className = 'text-console-14',
}: {
  text: string;
  chips: readonly ReferenceChip[];
  className?: string;
}): ReactElement {
  const remarkPlugins = useMemo(() => [remarkGfm, referenceChips(chips)], [chips]);
  return (
    <div
      className={`chat-markdown max-w-[80ch] leading-relaxed text-text-secondary [&_h1]:text-text-primary [&_h2]:text-text-primary [&_h3]:text-text-primary [&_strong]:text-text-primary ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A prompt as a readable document (owner change 7 of 2026-11-21): its headings, lists and code
 * as markdown, each reference the server found as a named chip, at a readable measure. A prompt
 * longer than `foldsPrompt` allows is clipped to its first screen under a fade, with "Show the
 * whole prompt".
 */
export function StepPrompt({
  prompt,
  chips,
}: {
  prompt: string;
  chips: readonly ReferenceChip[];
}): ReactElement {
  const folds = foldsPrompt(prompt);
  const [open, setOpen] = useState(false);
  const folded = folds && !open;
  return (
    <Panel className="flex flex-col gap-3 px-5 py-4">
      <div
        data-prompt-fold={folds ? (open ? 'open' : 'folded') : undefined}
        className={folded ? 'relative max-h-150 overflow-hidden' : ''}
      >
        <PromptMarkdown text={prompt} chips={chips} />
        {folded ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-surface-elevated"
          />
        ) : null}
      </div>
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="self-start rounded px-2 py-1 text-console-13 font-medium text-accent-bright hover:underline"
        >
          {open ? 'Show less' : 'Show the whole prompt'}
        </button>
      ) : null}
    </Panel>
  );
}
