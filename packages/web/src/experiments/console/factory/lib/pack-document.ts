/**
 * The pack's own document (`graph.document.text`: its markdown below the front matter) as the
 * Overview summarises it. Pure.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * The document's first paragraph, as the pack wrote it (its inline markdown kept), or null when
 * it has none. Headings, lists and other blocks before it are skipped. The markdown is parsed,
 * not split on blank lines, so a paragraph is what a markdown reader takes for one.
 */
export function firstParagraph(markdown: string): string | null {
  const paragraph = fromMarkdown(markdown).children.find(node => node.type === 'paragraph');
  const start = paragraph?.position?.start.offset;
  const end = paragraph?.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  return markdown.slice(start, end);
}
