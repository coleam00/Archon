import { describe, test, expect } from 'bun:test';
import { parseValidationResults } from './validation-parser';

// ---------------------------------------------------------------------------
// Helpers to build markdown content for tests
// ---------------------------------------------------------------------------

function makeContent(tableLines: string[], headerOverride?: string): string {
  const header = headerOverride ?? '# Validation Results';
  return [header, '', '| Check | Result |', '|-------|--------|', ...tableLines].join('\n');
}

// ---------------------------------------------------------------------------
// parseValidationResults
// ---------------------------------------------------------------------------

describe('parseValidationResults', () => {
  describe('returns empty array for invalid input', () => {
    test('empty string', () => {
      expect(parseValidationResults('')).toEqual([]);
    });

    test('content without Validation Results header', () => {
      const content = [
        '# Other Heading',
        '',
        '| Check | Result |',
        '|-------|--------|',
        '| type-check | ✅ |',
      ].join('\n');
      expect(parseValidationResults(content)).toEqual([]);
    });

    test('header present but no table', () => {
      const content = '# Validation Results\n\nSome prose, no table here.';
      expect(parseValidationResults(content)).toEqual([]);
    });

    test('header present but table is missing Check/Result columns', () => {
      const content = [
        '# Validation Results',
        '',
        '| Name | Status |',
        '|------|--------|',
        '| foo  | ✅     |',
      ].join('\n');
      expect(parseValidationResults(content)).toEqual([]);
    });

    test('whitespace-only content', () => {
      expect(parseValidationResults('   \n  \n  ')).toEqual([]);
    });
  });

  describe('parses a valid markdown table', () => {
    test('single passing row', () => {
      const content = makeContent(['| type-check | ✅ |']);
      expect(parseValidationResults(content)).toEqual([{ check: 'type-check', result: 'pass' }]);
    });

    test('single failing row', () => {
      const content = makeContent(['| lint | ❌ |']);
      expect(parseValidationResults(content)).toEqual([{ check: 'lint', result: 'fail' }]);
    });

    test('single warning row via ⚠️', () => {
      const content = makeContent(['| format | ⚠️ |']);
      expect(parseValidationResults(content)).toEqual([{ check: 'format', result: 'warn' }]);
    });

    test('single skipped row via ⏭️', () => {
      const content = makeContent(['| tests | ⏭️ |']);
      expect(parseValidationResults(content)).toEqual([{ check: 'tests', result: 'warn' }]);
    });

    test('single skipped row via "not run" text', () => {
      const content = makeContent(['| tests | not run |']);
      expect(parseValidationResults(content)).toEqual([
        { check: 'tests', result: 'warn', error: 'not run' },
      ]);
    });

    test('single skipped row via "skipped" text', () => {
      const content = makeContent(['| tests | Skipped |']);
      expect(parseValidationResults(content)).toEqual([
        { check: 'tests', result: 'warn', error: 'Skipped' },
      ]);
    });

    test('unknown result when no emoji and no keyword', () => {
      const content = makeContent(['| tests | running |']);
      expect(parseValidationResults(content)).toEqual([
        { check: 'tests', result: 'unknown', error: 'running' },
      ]);
    });

    test('multiple rows with mixed results', () => {
      const content = makeContent([
        '| type-check | ✅ |',
        '| lint       | ❌ |',
        '| tests      | ⚠️ |',
      ]);
      expect(parseValidationResults(content)).toEqual([
        { check: 'type-check', result: 'pass' },
        { check: 'lint', result: 'fail' },
        { check: 'tests', result: 'warn' },
      ]);
    });
  });

  describe('error text extraction', () => {
    test('error text after ❌ is captured', () => {
      const content = makeContent(['| lint | ❌ eslint rule violation |']);
      const results = parseValidationResults(content);
      expect(results[0].result).toBe('fail');
      expect(results[0].error).toBe('eslint rule violation');
    });

    test('error text with leading dash is stripped of the dash', () => {
      const content = makeContent(['| lint | ❌ - something broke |']);
      const results = parseValidationResults(content);
      expect(results[0].error).toBe('something broke');
    });

    test('error text with leading em-dash is stripped', () => {
      const content = makeContent(['| lint | ❌ — something broke |']);
      const results = parseValidationResults(content);
      expect(results[0].error).toBe('something broke');
    });

    test('no error field when result cell only contains emoji', () => {
      const content = makeContent(['| type-check | ✅ |']);
      const results = parseValidationResults(content);
      expect(results[0].error).toBeUndefined();
    });

    test('no error field for pass with only whitespace around emoji', () => {
      const content = makeContent(['| type-check |  ✅  |']);
      const results = parseValidationResults(content);
      expect(results[0].error).toBeUndefined();
    });

    test('warning with extra text captures error', () => {
      const content = makeContent(['| format | ⚠️ minor issues |']);
      const results = parseValidationResults(content);
      expect(results[0].result).toBe('warn');
      expect(results[0].error).toBe('minor issues');
    });
  });

  describe('check name normalization', () => {
    test('uppercase letters are lowercased', () => {
      const content = makeContent(['| TypeCheck | ✅ |']);
      expect(parseValidationResults(content)[0].check).toBe('typecheck');
    });

    test('spaces are replaced with hyphens', () => {
      const content = makeContent(['| type check | ✅ |']);
      expect(parseValidationResults(content)[0].check).toBe('type-check');
    });

    test('multiple consecutive spaces become single hyphen', () => {
      const content = makeContent(['| type  check | ✅ |']);
      expect(parseValidationResults(content)[0].check).toBe('type-check');
    });

    test('special characters are stripped', () => {
      const content = makeContent(['| type_check! | ✅ |']);
      // underscores and ! are stripped; becomes 'typecheck'
      expect(parseValidationResults(content)[0].check).toBe('typecheck');
    });

    test('hyphens are preserved', () => {
      const content = makeContent(['| e2e-tests | ✅ |']);
      expect(parseValidationResults(content)[0].check).toBe('e2e-tests');
    });

    test('numbers are preserved', () => {
      const content = makeContent(['| step1 | ✅ |']);
      expect(parseValidationResults(content)[0].check).toBe('step1');
    });
  });

  describe('table parsing edge cases', () => {
    test('separator row is skipped', () => {
      // separator already included by makeContent; ensure row count is correct
      const content = makeContent(['| type-check | ✅ |']);
      expect(parseValidationResults(content)).toHaveLength(1);
    });

    test('row with fewer than 2 non-empty cells is skipped', () => {
      // A row that splits into only one cell after filter
      const content = makeContent(['| | |']);
      // Both cells are empty strings, filtered out → length < 2 → skipped
      expect(parseValidationResults(content)).toEqual([]);
    });

    test('table parsing stops when a non-pipe line is encountered', () => {
      const content = makeContent(['| type-check | ✅ |', '', '| lint | ❌ |']);
      // Empty line breaks the table loop, so only the first row is parsed
      expect(parseValidationResults(content)).toHaveLength(1);
      expect(parseValidationResults(content)[0].check).toBe('type-check');
    });

    test('extra columns beyond the second are ignored', () => {
      const content = makeContent(['| type-check | ✅ | extra-column |']);
      expect(parseValidationResults(content)).toEqual([{ check: 'type-check', result: 'pass' }]);
    });

    test('header match is case-sensitive for "Validation Results"', () => {
      const content = [
        '# validation results',
        '',
        '| Check | Result |',
        '|-------|--------|',
        '| type-check | ✅ |',
      ].join('\n');
      // lowercase header should NOT match
      expect(parseValidationResults(content)).toEqual([]);
    });

    test('header can appear after other content', () => {
      const content = [
        'Some preamble text',
        '',
        '# Validation Results',
        '',
        '| Check | Result |',
        '|-------|--------|',
        '| lint | ✅ |',
      ].join('\n');
      expect(parseValidationResults(content)).toEqual([{ check: 'lint', result: 'pass' }]);
    });

    test('Windows-style CRLF line endings are handled', () => {
      const content =
        '# Validation Results\r\n\r\n| Check | Result |\r\n|-------|--------|\r\n| lint | ✅ |\r\n';
      expect(parseValidationResults(content)).toEqual([{ check: 'lint', result: 'pass' }]);
    });

    test('check name that normalizes to empty string is skipped', () => {
      // A check name consisting only of special chars will normalize to ''
      const content = makeContent(['| !@#$ | ✅ |']);
      expect(parseValidationResults(content)).toEqual([]);
    });
  });

  describe('emoji precedence', () => {
    test('✅ takes priority when multiple emojis present', () => {
      // hasPass checked first
      const content = makeContent(['| mixed | ✅ ❌ |']);
      expect(parseValidationResults(content)[0].result).toBe('pass');
    });

    test('❌ takes priority over ⚠️', () => {
      const content = makeContent(['| mixed | ❌ ⚠️ |']);
      expect(parseValidationResults(content)[0].result).toBe('fail');
    });

    test('⚠️ takes priority over plain text unknown', () => {
      const content = makeContent(['| mixed | ⚠️ some text |']);
      expect(parseValidationResults(content)[0].result).toBe('warn');
    });
  });
});
