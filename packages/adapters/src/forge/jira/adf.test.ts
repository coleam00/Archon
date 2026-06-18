/**
 * Unit tests for ADF conversion helpers (pure functions — no module mocks).
 */
import { describe, test, expect } from 'bun:test';
import { toAdf, adfToPlainText } from './adf';
import type { AdfDoc } from './types';

describe('toAdf', () => {
  test('wraps a plain line in a paragraph', () => {
    const doc = toAdf('hello world');
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] },
    ]);
  });

  test('renders headings with level', () => {
    const doc = toAdf('## Title');
    expect(doc.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Title' }],
    });
  });

  test('renders fenced code blocks with language', () => {
    const doc = toAdf('```ts\nconst a = 1;\n```');
    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const a = 1;' }],
    });
  });

  test('renders bullet lists', () => {
    const doc = toAdf('- one\n- two');
    const list = doc.content[0];
    expect(list.type).toBe('bulletList');
    expect(list.content).toHaveLength(2);
    expect(list.content?.[0]).toEqual({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
    });
  });

  test('renders inline code spans', () => {
    const doc = toAdf('use `npm install` now');
    expect(doc.content[0].content).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'text', text: 'npm install', marks: [{ type: 'code' }] },
      { type: 'text', text: ' now' },
    ]);
  });

  test('separates paragraphs on blank lines', () => {
    const doc = toAdf('first para\n\nsecond para');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].type).toBe('paragraph');
    expect(doc.content[1].type).toBe('paragraph');
  });

  test('never produces empty content (degrades safely)', () => {
    const doc = toAdf('');
    expect(doc.content.length).toBeGreaterThan(0);
    expect(doc.content[0].type).toBe('paragraph');
  });
});

describe('adfToPlainText', () => {
  test('returns string body unchanged', () => {
    expect(adfToPlainText('plain text')).toBe('plain text');
  });

  test('returns empty string for null/undefined', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
  });

  test('flattens an ADF doc to text', () => {
    const doc: AdfDoc = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '@Archon fix this' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second line' }] },
      ],
    };
    const text = adfToPlainText(doc);
    expect(text).toContain('@Archon fix this');
    expect(text).toContain('second line');
  });

  test('round-trips a mention through toAdf and back', () => {
    const original = '@Archon please run the tests';
    expect(adfToPlainText(toAdf(original))).toContain(original);
  });

  test('handles unknown node shapes without throwing', () => {
    // @ts-expect-error intentionally malformed body
    expect(adfToPlainText({ foo: 'bar' })).toBe('');
  });
});
