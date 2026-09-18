import { describe, test, expect } from 'bun:test';
import { isAcceptedFileType, formatBytes, dragHasFiles } from './file';

const file = (name: string, type = ''): File => new File(['x'], name, { type });

describe('isAcceptedFileType', () => {
  test('accepts by MIME — text/*, image/*, pdf, json', () => {
    expect(isAcceptedFileType(file('a', 'text/plain'))).toBe(true);
    expect(isAcceptedFileType(file('a', 'image/png'))).toBe(true);
    expect(isAcceptedFileType(file('a', 'application/pdf'))).toBe(true);
    expect(isAcceptedFileType(file('a', 'application/json'))).toBe(true);
  });

  test('accepts by extension when the MIME type is empty (code/config files)', () => {
    expect(isAcceptedFileType(file('main.py'))).toBe(true);
    expect(isAcceptedFileType(file('schema.sql'))).toBe(true);
    expect(isAcceptedFileType(file('Config.YAML'))).toBe(true); // case-insensitive
  });

  test('rejects an unknown extension with an empty MIME', () => {
    expect(isAcceptedFileType(file('archive.zip'))).toBe(false);
    expect(isAcceptedFileType(file('binary.exe'))).toBe(false);
  });

  test('rejects no-extension files and dotfiles', () => {
    expect(isAcceptedFileType(file('Makefile'))).toBe(false);
    expect(isAcceptedFileType(file('.gitignore'))).toBe(false);
  });
});

describe('formatBytes', () => {
  test('formats B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });
});

describe('dragHasFiles', () => {
  test('true when the drag carries files', () => {
    expect(dragHasFiles(['Files'])).toBe(true);
    // A desktop file drag commonly advertises several types alongside Files.
    expect(dragHasFiles(['application/x-moz-file', 'Files'])).toBe(true);
  });

  test('false for a text drag — selecting inside the textarea and dragging it', () => {
    expect(dragHasFiles(['text/plain'])).toBe(false);
    expect(dragHasFiles(['text/plain', 'text/html'])).toBe(false);
  });

  test('false for a drag that advertises nothing', () => {
    expect(dragHasFiles([])).toBe(false);
  });

  test("reads array-likes, since Safari's types is a DOMStringList", () => {
    const domStringList = { length: 1, 0: 'Files' } as unknown as DataTransfer['types'];
    expect(dragHasFiles(domStringList)).toBe(true);
  });
});
