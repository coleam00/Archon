/**
 * Which changed files the test-value judge reads in full. It lives in the judge's
 * directory so the judge identity hashes it: changing which files the judge reads
 * changes which tests it can name, and so the judge.
 */

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/;
/** Documentation, whose examples can show test code without being tests. */
const PROSE_PATH = /\.(md|mdx|markdown|rst|txt)$/i;
/** A test-framework call or definition in source: `describe(`, `it(`, `test(`, `expect(`, `def test_`, `func Test`. */
const TEST_CODE = /(^|[^.\w])(describe|it|test|expect)(\.\w+)*\s*\(|\bdef test_\w*\s*\(|\bfunc Test\w*\s*\(/m;

/**
 * Whether a changed file holds test code the judge should read in full: a test file by
 * its path, or a source file whose patch shows test-framework code, such as a shared
 * conformance suite that lives outside `*.test.*` files.
 */
export function holdsTestCode(path: string, patch: string): boolean {
  return TEST_PATH.test(path) || (!PROSE_PATH.test(path) && TEST_CODE.test(patch));
}
