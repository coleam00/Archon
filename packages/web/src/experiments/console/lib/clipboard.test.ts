import { describe, test, expect } from 'bun:test';
import { copyLabel, writeClipboardText } from './clipboard';

const ok = { writeText: async (): Promise<void> => undefined };
const broken = {
  writeText: async (): Promise<void> => {
    throw new Error('not allowed');
  },
};

describe('writeClipboardText', () => {
  test('reports success when the write lands', async () => {
    expect(await writeClipboardText('hello', ok)).toBe(true);
  });

  test('reports failure instead of throwing when the API rejects', async () => {
    // Plain HTTP and older browsers reject; a silent failure would leave the
    // user believing they had copied something.
    expect(await writeClipboardText('hello', broken)).toBe(false);
  });

  test('reports failure when there is no clipboard at all', async () => {
    expect(await writeClipboardText('hello', undefined)).toBe(false);
  });

  test('refuses empty text rather than clearing the clipboard', async () => {
    expect(await writeClipboardText('', ok)).toBe(false);
  });
});

describe('copyLabel', () => {
  test('each control names its own scope when confirming', () => {
    // Two controls sit on screen together, so the confirmation has to say
    // whether one command or the whole reply was copied.
    expect(copyLabel('copied', 'Copy', 'Copied')).toBe('Copied');
    expect(copyLabel('copied', 'Copy message', 'Message copied')).toBe('Message copied');
  });

  test('failure tells the user what to do instead', () => {
    expect(copyLabel('failed', 'Copy', 'Copied')).toBe('Press ⌘C');
    expect(copyLabel('failed', 'Copy message', 'Message copied')).toBe('Press ⌘C');
  });

  test('at rest it is just the resting label', () => {
    expect(copyLabel('idle', 'Copy', 'Copied')).toBe('Copy');
    expect(copyLabel('idle', 'Copy message', 'Message copied')).toBe('Copy message');
  });
});
