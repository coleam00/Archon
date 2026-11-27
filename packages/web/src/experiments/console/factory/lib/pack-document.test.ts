import { describe, expect, test } from 'bun:test';
import { firstParagraph } from './pack-document';

describe("the pack document's first paragraph", () => {
  test('skips the heading before it and stops at the blank line after it', () => {
    const text =
      '# How the factory works\n\nWork comes in as a work order.\nIt is triaged.\n\n## Then\n\nMore.';
    expect(firstParagraph(text)).toBe('Work comes in as a work order.\nIt is triaged.');
  });

  test('keeps its inline markdown as written', () => {
    const text = '# Title\n\nAn **order**, then a [link](https://example.com/x) and `code`.\n';
    expect(firstParagraph(text)).toBe(
      'An **order**, then a [link](https://example.com/x) and `code`.'
    );
  });

  test('none when the document has only headings and lists', () => {
    expect(firstParagraph('# Title\n\n- **A.** one\n- **B.** two\n')).toBeNull();
    expect(firstParagraph('')).toBeNull();
  });
});
