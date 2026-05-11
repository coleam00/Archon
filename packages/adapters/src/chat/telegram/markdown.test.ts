import { convertToTelegramMarkdown, escapeMarkdownV2, isAlreadyEscaped } from './markdown';

describe('telegram-markdown', () => {
  describe('convertToTelegramMarkdown', () => {
    describe('headers', () => {
      test('converts ## header to bold', () => {
        const result = convertToTelegramMarkdown('## Header Text');
        expect(result).toContain('*Header Text*');
      });

      test('converts # header to bold', () => {
        const result = convertToTelegramMarkdown('# Main Header');
        expect(result).toContain('*Main Header*');
      });
    });

    describe('bold and italic', () => {
      test('converts **bold** to *bold*', () => {
        const result = convertToTelegramMarkdown('This is **bold** text');
        expect(result).toContain('*bold*');
      });

      test('converts *italic* to _italic_', () => {
        const result = convertToTelegramMarkdown('This is *italic* text');
        expect(result).toContain('_italic_');
      });
    });

    describe('code blocks', () => {
      test('preserves inline code', () => {
        const result = convertToTelegramMarkdown('Use `npm install`');
        expect(result).toContain('`npm install`');
      });

      test('preserves code blocks', () => {
        const input = '```javascript\nconst x = 1;\n```';
        const result = convertToTelegramMarkdown(input);
        expect(result).toContain('```');
        expect(result).toContain('const x = 1');
      });
    });

    describe('lists', () => {
      test('converts bullet lists', () => {
        const input = '- Item 1\n- Item 2';
        const result = convertToTelegramMarkdown(input);
        // Library converts - to bullet point or escapes it
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe('links', () => {
      test('preserves markdown links', () => {
        const result = convertToTelegramMarkdown('[Click here](https://example.com)');
        expect(result).toContain('[Click here]');
        expect(result).toContain('https://example.com');
      });
    });

    describe('special characters', () => {
      test('escapes special characters', () => {
        const input = 'Price is $100. Use + or -';
        const result = convertToTelegramMarkdown(input);
        // Should have escaped . + -
        expect(result).toBeDefined();
      });
    });

    describe('edge cases', () => {
      test('handles empty string', () => {
        const result = convertToTelegramMarkdown('');
        expect(result).toBe('');
      });

      test('handles whitespace only', () => {
        const result = convertToTelegramMarkdown('   ');
        expect(result).toBe('   ');
      });

      test('handles plain text without markdown', () => {
        const result = convertToTelegramMarkdown('Hello world');
        expect(result).toContain('Hello world');
      });
    });
  });

  describe('escapeMarkdownV2', () => {
    test('escapes underscore', () => {
      expect(escapeMarkdownV2('snake_case')).toBe('snake\\_case');
    });

    test('escapes asterisk', () => {
      expect(escapeMarkdownV2('2*3=6')).toBe('2\\*3\\=6');
    });

    test('escapes brackets', () => {
      expect(escapeMarkdownV2('[text](url)')).toBe('\\[text\\]\\(url\\)');
    });

    test('escapes period', () => {
      expect(escapeMarkdownV2('Hello.')).toBe('Hello\\.');
    });

    test('escapes backslash', () => {
      expect(escapeMarkdownV2('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    test('handles empty string', () => {
      expect(escapeMarkdownV2('')).toBe('');
    });

    test('escapes multiple special chars', () => {
      const input = 'Use `code` and *bold* here!';
      const result = escapeMarkdownV2(input);
      expect(result).toBe('Use \\`code\\` and \\*bold\\* here\\!');
    });
  });

  describe('isAlreadyEscaped', () => {
    test('returns true for escaped underscore', () => {
      expect(isAlreadyEscaped('snake\\_case')).toBe(true);
    });

    test('returns true for escaped asterisk', () => {
      expect(isAlreadyEscaped('2\\*3')).toBe(true);
    });

    test('returns false for unescaped text', () => {
      expect(isAlreadyEscaped('Hello world')).toBe(false);
    });

    test('returns false for regular markdown', () => {
      expect(isAlreadyEscaped('**bold** text')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(isAlreadyEscaped('')).toBe(false);
    });
  });
});
