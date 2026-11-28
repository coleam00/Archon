/**
 * A pack's own document as a person reads it: the markdown below its front matter, as the pack
 * wrote it (`graph.document.text`, `pack-document.ts` in the engine). How it works draws it
 * whole; the Overview draws its first paragraph as the pack's summary (`firstParagraph`).
 */
import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';

/** The document's type, in the Visual standard's roles: headings, body, lists and code. */
const PROSE = [
  'max-w-3xl text-console-14 leading-relaxed text-text-secondary',
  '[&_h1]:text-console-17 [&_h1]:font-semibold [&_h1]:text-text-primary',
  '[&_h2]:mt-6 [&_h2]:text-console-15 [&_h2]:font-semibold [&_h2]:text-text-primary',
  '[&_h3]:mt-4 [&_h3]:font-medium [&_h3]:text-text-primary',
  '[&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:mt-1 [&_strong]:font-semibold [&_strong]:text-text-primary',
  '[&_code]:font-mono [&_code]:text-console-13 [&_code]:text-text-primary',
  '[&_a]:text-accent-bright [&_a]:underline',
].join(' ');

const LABEL = 'text-console-12 font-medium uppercase tracking-console-label text-text-tertiary';

/** The whole document, under a "How it works" label. */
export function PackDocument({ text }: { text: string }): ReactElement {
  return (
    <section aria-label="How it works" data-document className="flex flex-col gap-3">
      <h2 className={LABEL}>How it works</h2>
      <div className={PROSE}>
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </section>
  );
}

/** One paragraph of the document, inline markdown kept, as the summary under a pack's name. */
export function DocumentSummary({ markdown }: { markdown: string }): ReactElement {
  return (
    <div data-summary className={PROSE}>
      <ReactMarkdown>{markdown}</ReactMarkdown>
    </div>
  );
}
