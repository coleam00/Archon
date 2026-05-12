import { describe, test, expect } from 'bun:test';
import { isValidCommandName } from './command-validation';

describe('isValidCommandName', () => {
  // ---------------------------------------------------------------------------
  // Valid names
  // ---------------------------------------------------------------------------

  describe('valid names', () => {
    test('simple lowercase name', () => {
      expect(isValidCommandName('build')).toBe(true);
    });

    test('name with hyphens', () => {
      expect(isValidCommandName('type-check')).toBe(true);
    });

    test('name with underscores', () => {
      expect(isValidCommandName('run_tests')).toBe(true);
    });

    test('name with numbers', () => {
      expect(isValidCommandName('step1')).toBe(true);
    });

    test('uppercase letters are allowed', () => {
      expect(isValidCommandName('TypeCheck')).toBe(true);
    });

    test('mixed alphanumeric with hyphens', () => {
      expect(isValidCommandName('e2e-tests')).toBe(true);
    });

    test('single character name', () => {
      expect(isValidCommandName('x')).toBe(true);
    });

    test('name with spaces (not a path separator)', () => {
      // The function only blocks /, \, .., and leading dot — spaces are allowed
      expect(isValidCommandName('my command')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Path traversal attempts
  // ---------------------------------------------------------------------------

  describe('path traversal — double dot (..)', () => {
    test('bare ".."', () => {
      expect(isValidCommandName('..')).toBe(false);
    });

    test('"../etc/passwd"', () => {
      expect(isValidCommandName('../etc/passwd')).toBe(false);
    });

    test('"../../secret"', () => {
      expect(isValidCommandName('../../secret')).toBe(false);
    });

    test('embedded ".." in the middle', () => {
      expect(isValidCommandName('foo..bar')).toBe(false);
    });

    test('"commands/.."', () => {
      expect(isValidCommandName('commands/..')).toBe(false);
    });
  });

  describe('path traversal — forward slash (/)', () => {
    test('bare "/"', () => {
      expect(isValidCommandName('/')).toBe(false);
    });

    test('"sub/command"', () => {
      expect(isValidCommandName('sub/command')).toBe(false);
    });

    test('trailing slash "build/"', () => {
      expect(isValidCommandName('build/')).toBe(false);
    });

    test('leading slash "/build"', () => {
      expect(isValidCommandName('/build')).toBe(false);
    });

    test('absolute path "/etc/passwd"', () => {
      expect(isValidCommandName('/etc/passwd')).toBe(false);
    });
  });

  describe('path traversal — backslash (\\\\)', () => {
    test('bare backslash', () => {
      expect(isValidCommandName('\\')).toBe(false);
    });

    test('Windows-style path "sub\\\\command"', () => {
      expect(isValidCommandName('sub\\command')).toBe(false);
    });

    test('Windows absolute path "C:\\\\Windows"', () => {
      expect(isValidCommandName('C:\\Windows')).toBe(false);
    });

    test('trailing backslash', () => {
      expect(isValidCommandName('build\\')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Leading dot
  // ---------------------------------------------------------------------------

  describe('leading dot', () => {
    test('single leading dot ".hidden"', () => {
      expect(isValidCommandName('.hidden')).toBe(false);
    });

    test('bare single dot "."', () => {
      expect(isValidCommandName('.')).toBe(false);
    });

    test('".archon" directory name', () => {
      expect(isValidCommandName('.archon')).toBe(false);
    });

    test('".gitignore" style name', () => {
      expect(isValidCommandName('.gitignore')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty / whitespace-only names
  // ---------------------------------------------------------------------------

  describe('empty and whitespace-only names', () => {
    test('empty string', () => {
      expect(isValidCommandName('')).toBe(false);
    });

    test('whitespace only — single space', () => {
      // A single space doesn't start with '.' and contains no path separators,
      // but the function returns true for it (it is not explicitly rejected).
      // This test documents the actual behavior.
      expect(isValidCommandName(' ')).toBe(true);
    });

    test('whitespace only — multiple spaces', () => {
      // Same reasoning: spaces alone pass the current checks.
      expect(isValidCommandName('   ')).toBe(true);
    });

    test('tab character alone', () => {
      expect(isValidCommandName('\t')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Combined / tricky cases
  // ---------------------------------------------------------------------------

  describe('combined edge cases', () => {
    test('name with ".." suffix but no slash is still rejected', () => {
      expect(isValidCommandName('foo..')).toBe(false);
    });

    test('name starting with valid char followed by backslash is rejected', () => {
      expect(isValidCommandName('a\\b')).toBe(false);
    });

    test('name with forward slash anywhere is rejected', () => {
      expect(isValidCommandName('a/b/c')).toBe(false);
    });

    test('long valid name', () => {
      const longName = 'a'.repeat(200);
      expect(isValidCommandName(longName)).toBe(true);
    });

    test('numeric-only name', () => {
      expect(isValidCommandName('123')).toBe(true);
    });
  });
});
