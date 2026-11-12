/**
 * Which changed files the test-value judge reads in full. It lives in the judge's
 * directory so the judge identity hashes it: changing which files the judge reads
 * changes which tests it can name, and so the judge.
 */

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/;
/** Documentation, whose examples can show test code without being tests. */
const PROSE_PATH = /\.(md|mdx|markdown|rst|txt)$/i;
/** A test-framework call or definition in one line: `describe(`, `it(`, `test(`, `expect(`, `def test_`, `func Test`. */
const TEST_CODE = /(^|[^.\w])(describe|it|test|expect)(\.\w+)*\s*\(|\bdef test_\w*\s*\(|\bfunc Test\w*\s*\(/;

/**
 * Whether a changed file holds test code the judge should read in full: a test file by
 * its path, or a source file whose patch adds test-framework code, such as a shared
 * conformance suite that lives outside `*.test.*` files. Added and unchanged lines
 * count; a hunk header or a removed line does not, since it names code the file may no
 * longer have. Unchanged lines count because a changed test's body can show its
 * `expect(` only in the lines around the edit.
 *
 * A file the forge reports without a patch (binary, or a diff too large to render) counts
 * only by its path. Its text would mostly exceed what the reader inlines anyway.
 */
export function holdsTestCode(path: string, patch: string | null): boolean {
  if (TEST_PATH.test(path)) return true;
  if (patch === null || PROSE_PATH.test(path)) return false;
  return patch
    .split('\n')
    .some(line => (line.startsWith('+') || line.startsWith(' ')) && TEST_CODE.test(line.slice(1)));
}
