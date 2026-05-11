import { describe, expect, test } from 'bun:test';
import { splitIntoParagraphChunks } from './message-splitting';

describe('splitIntoParagraphChunks', () => {
  test('empty string returns empty array', () => {
    expect(splitIntoParagraphChunks('', 100)).toEqual([]);
  });

  test('short message returns single chunk', () => {
    const msg = 'Hello world';
    expect(splitIntoParagraphChunks(msg, 100)).toEqual(['Hello world']);
  });

  test('two paragraphs that fit return single chunk', () => {
    const msg = 'First paragraph.\n\nSecond paragraph.';
    expect(splitIntoParagraphChunks(msg, 100)).toEqual([msg]);
  });

  test('two paragraphs that do not fit return two chunks', () => {
    const msg = 'First paragraph here.\n\nSecond paragraph here.';
    // maxLength < total but > each paragraph
    expect(splitIntoParagraphChunks(msg, 25)).toEqual([
      'First paragraph here.',
      'Second paragraph here.',
    ]);
  });

  test('single long paragraph falls back to line splitting', () => {
    const msg = 'Line one\nLine two\nLine three';
    // maxLength can fit ~1 line but not all
    expect(splitIntoParagraphChunks(msg, 15)).toEqual(['Line one', 'Line two', 'Line three']);
  });

  test('single line longer than maxLength stays as one chunk', () => {
    const msg = 'ThisIsASingleVeryLongLineWithNoBreaks';
    expect(splitIntoParagraphChunks(msg, 10)).toEqual([msg]);
  });

  test('message exactly at maxLength returns single chunk', () => {
    const msg = 'ABCDE';
    expect(splitIntoParagraphChunks(msg, 5)).toEqual(['ABCDE']);
  });

  test('multiple paragraph breaks are normalized', () => {
    const msg = 'Para one.\n\n\n\nPara two.';
    expect(splitIntoParagraphChunks(msg, 100)).toEqual(['Para one.\n\nPara two.']);
  });

  test('combines short paragraphs then splits when exceeding', () => {
    const msg = 'A\n\nB\n\nC\n\nD';
    // maxLength can fit A + B but not A + B + C
    expect(splitIntoParagraphChunks(msg, 6)).toEqual(['A\n\nB', 'C\n\nD']);
  });

  test('mixed: some paragraphs fit, one triggers line fallback', () => {
    const shortPara = 'Short paragraph.';
    const longPara = 'Line A\nLine B\nLine C\nLine D';
    const msg = `${shortPara}\n\n${longPara}`;
    // maxLength 20: shortPara (16 chars) fits alone, longPara (27 chars) triggers line splitting
    // Lines A+B+C group together (18 chars with newlines), D gets its own chunk
    const result = splitIntoParagraphChunks(msg, 20);
    expect(result).toEqual(['Short paragraph.', 'Line A\nLine B\nLine C', 'Line D']);
  });
});
