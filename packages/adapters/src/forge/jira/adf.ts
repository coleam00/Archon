/**
 * Minimal Atlassian Document Format (ADF) helpers.
 *
 * Jira Cloud REST v3 stores and accepts comment bodies as ADF (a structured
 * JSON document), not markdown or HTML. These helpers convert between the
 * plain/markdown-ish text Archon produces and the ADF the API requires, and
 * extract plain text from inbound comment bodies.
 *
 * Scope is deliberately small (KISS): paragraphs, fenced code blocks, ATX
 * headings, bullet lists, and inline code. Anything unrecognized degrades to a
 * plain paragraph — the renderer never throws on exotic input.
 */
import type { AdfDoc, AdfNode, JiraCommentBody } from './types';

/** Build an ADF text node, optionally with an inline `code` mark. */
function textNode(text: string, code = false): AdfNode {
  const node: AdfNode = { type: 'text', text };
  if (code) node.marks = [{ type: 'code' }];
  return node;
}

/**
 * Parse a single line into ADF inline nodes, splitting on backtick-delimited
 * `inline code` spans. Plain text outside backticks becomes text nodes.
 */
function inlineContent(line: string): AdfNode[] {
  if (!line) return [textNode('')];

  const nodes: AdfNode[] = [];
  const parts = line.split('`');
  // Odd indices are inside backticks (code), even indices are plain text.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    nodes.push(textNode(parts[i], i % 2 === 1));
  }
  return nodes.length > 0 ? nodes : [textNode('')];
}

/**
 * Convert a markdown-ish string into a minimal ADF document.
 *
 * Recognized block constructs:
 * - ```fenced code blocks``` → codeBlock (language captured when present)
 * - `# heading` (1–6 `#`) → heading
 * - `- ` / `* ` lines → bulletList with listItems
 * - blank-line-separated paragraphs → paragraph
 */
export function toAdf(text: string): AdfDoc {
  const content: AdfNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  let paragraphBuffer: string[] = [];
  let listBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return;
    const joined = paragraphBuffer.join('\n');
    content.push({ type: 'paragraph', content: inlineContent(joined) });
    paragraphBuffer = [];
  };

  const flushList = (): void => {
    if (listBuffer.length === 0) return;
    content.push({
      type: 'bulletList',
      content: listBuffer.map(item => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: inlineContent(item) }],
      })),
    });
    listBuffer = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = /^```(\w+)?\s*$/.exec(line);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      const language = fenceMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or past EOF)
      const codeNode: AdfNode = {
        type: 'codeBlock',
        content: [textNode(codeLines.join('\n'))],
      };
      if (language) codeNode.attrs = { language };
      content.push(codeNode);
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      content.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: inlineContent(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Bullet list item
    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      flushParagraph();
      listBuffer.push(bulletMatch[1]);
      i++;
      continue;
    }

    // Blank line ends the current paragraph/list
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    // Regular text — accumulate into the current paragraph
    flushList();
    paragraphBuffer.push(line);
    i++;
  }

  flushParagraph();
  flushList();

  // ADF requires at least one content node.
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [textNode('')] });
  }

  return { version: 1, type: 'doc', content };
}

/**
 * Recursively collect text from an ADF node tree.
 * Inserts newlines after block-level nodes so paragraphs stay separated.
 */
function collectText(node: AdfNode): string {
  if (node.type === 'text') {
    return node.text ?? '';
  }

  const childText = (node.content ?? []).map(collectText).join('');

  // Block-level nodes get a trailing newline so structure survives flattening.
  const blockTypes = new Set(['paragraph', 'heading', 'codeBlock', 'listItem', 'blockquote']);
  return blockTypes.has(node.type) ? `${childText}\n` : childText;
}

/**
 * Extract plain text from a Jira comment body, which may be either a plain
 * string (classic webhook delivery) or an ADF object (REST v3). Never throws —
 * unrecognized shapes return an empty string.
 */
export function adfToPlainText(body: JiraCommentBody | null | undefined): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;

  if (typeof body === 'object' && 'type' in body) {
    return collectText(body as AdfNode)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return '';
}
