import { describe, expect, test } from 'bun:test';
import { filterToolIndicators } from './batch-reply';

describe('filterToolIndicators', () => {
  test('returns empty string for empty array', () => {
    expect(filterToolIndicators([])).toBe('');
  });

  test.each([
    [['This is a regular message.'], 'This is a regular message.'],
    [['  Regular text with leading spaces.  '], 'Regular text with leading spaces.'],
    [['', 'Actual content here.', ''], 'Actual content here.'],
    [
      ['Here is the example:', '    print("hello")\n    print("bye")'],
      'Here is the example:\n\n---\n\n    print("hello")\n    print("bye")',
    ],
  ])('preserves retained text and trims only the joined reply: %j', (messages, expected) => {
    expect(filterToolIndicators(messages)).toBe(expected);
  });

  test('filters 🔧 (U+1F527) tool usage indicator', () => {
    const result = filterToolIndicators(['🔧 Running tool foo', 'The answer is 42.']);
    expect(result).not.toContain('🔧');
    expect(result).toContain('The answer is 42.');
  });

  test('filters 💭 (U+1F4AD) thinking indicator', () => {
    const result = filterToolIndicators([
      '💭 Thinking about the problem...',
      'Here is my response.',
    ]);
    expect(result).not.toContain('💭');
    expect(result).toContain('Here is my response.');
  });

  test('filters 📝 (U+1F4DD) writing indicator', () => {
    const result = filterToolIndicators(['📝 Writing file output.txt', 'Done writing.']);
    expect(result).not.toContain('📝');
    expect(result).toContain('Done writing.');
  });

  test('filters ✏️ (U+270F+FE0F) editing indicator', () => {
    const result = filterToolIndicators(['\u{270F}\u{FE0F} Editing main.ts', 'Edit complete.']);
    expect(result).not.toContain('\u{270F}');
    expect(result).toContain('Edit complete.');
  });

  test('filters 🗑️ (U+1F5D1+FE0F) deleting indicator', () => {
    const result = filterToolIndicators(['\u{1F5D1}\u{FE0F} Deleting temp file', 'File removed.']);
    expect(result).not.toContain('\u{1F5D1}');
    expect(result).toContain('File removed.');
  });

  test('filters 📂 (U+1F4C2) folder indicator', () => {
    const result = filterToolIndicators(['📂 Reading directory /src', 'Directory listed.']);
    expect(result).not.toContain('📂');
    expect(result).toContain('Directory listed.');
  });

  test('filters 🔍 (U+1F50D) search indicator', () => {
    const result = filterToolIndicators(['🔍 Searching for pattern', 'Search complete.']);
    expect(result).not.toContain('🔍');
    expect(result).toContain('Search complete.');
  });

  test('preserves emoji that is not a tool indicator', () => {
    const result = filterToolIndicators(['🎉 Deployment successful!']);
    expect(result).toContain('🎉 Deployment successful!');
  });

  test('preserves text that contains tool emoji but does not START with it', () => {
    const result = filterToolIndicators(['Here is a 🔧 wrench emoji mid-text.']);
    expect(result).toContain('🔧');
  });

  test('falls back to all messages when everything gets filtered out', () => {
    expect(filterToolIndicators(['🔧 Tool call one'])).toBe('🔧 Tool call one');
    expect(filterToolIndicators(['🔧 Tool call one', '💭 Thinking...'])).toBe(
      '🔧 Tool call one\n\n---\n\n💭 Thinking...'
    );
  });

  test('handles multiple assistant messages joined with separator', () => {
    const messages = [
      'First part of the response.',
      '🔧 Some tool usage here',
      'Second part of the response.',
    ];
    const result = filterToolIndicators(messages);
    expect(result).toBe('First part of the response.\n\n---\n\nSecond part of the response.');
  });

  test('sections within a single message are split by double newlines', () => {
    const messages = ['Normal text.\n\n🔧 Tool output.\n\nMore normal text.'];
    const result = filterToolIndicators(messages);
    expect(result).toContain('Normal text.');
    expect(result).toContain('More normal text.');
    expect(result).not.toContain('🔧');
  });
});

test.each([
  [' tool output\n\nFinal answer', 'Final answer'],
  [' tool output', '🔧 Running tool output'],
])('keeps indicator section identity across a warning flush: %j', (tail, expected) => {
  expect(
    filterToolIndicators([{ text: '🔧 Running' }, { text: tail, continuesPreviousBlock: true }])
  ).toBe(expected);
});

test('fallback joins warning-split blocks before separating independent indicators', () => {
  expect(
    filterToolIndicators([
      { text: '🔧 Running' },
      { text: ' tool', continuesPreviousBlock: true },
      { text: ' output', continuesPreviousBlock: true },
      { text: '💭 Thinking' },
      { text: '...', continuesPreviousBlock: true },
    ])
  ).toBe('🔧 Running tool output\n\n---\n\n💭 Thinking...');
});

test('joins continuations before finding section boundaries and preserves later blocks', () => {
  expect(
    filterToolIndicators([
      { text: '🔧 Running\n' },
      { text: '\nFinal', continuesPreviousBlock: true },
      { text: ' answer', continuesPreviousBlock: true },
      { text: '    indented example' },
    ])
  ).toBe('Final answer\n\n---\n\n    indented example');
});
