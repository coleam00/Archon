import { describe, test, expect } from 'bun:test';
import { pathTokens, shortenText, type ShortenedPart } from './run-paths';

const WORKTREE = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\worktrees\\feat\\x';
const RUNS = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\artifacts\\runs';
const RUN = `${RUNS}\\0a81ff6c`;

const tokens = pathTokens([
  { kind: 'checkout', path: WORKTREE },
  { kind: 'artifact_runs', path: RUNS },
  { kind: 'run_artifacts', path: RUN },
]);

/** The shortened text as displayed, a token shown by its name. */
const shown = (parts: readonly ShortenedPart[]): string =>
  parts.map(part => (typeof part === 'string' ? part : part.token)).join('');
/** The shortened text with every token put back as its recorded path. */
const restored = (parts: readonly ShortenedPart[]): string =>
  parts.map(part => (typeof part === 'string' ? part : part.path)).join('');

describe('pathTokens', () => {
  test('orders longest path first, drops empty and repeated paths and a trailing separator', () => {
    const made = pathTokens([
      { kind: 'artifact_runs', path: `${RUNS}\\` },
      { kind: 'checkout', path: '' },
      { kind: 'run_artifacts', path: RUN },
      { kind: 'workflow_source', path: RUN },
    ]);
    expect(made.map(token => [token.token, token.path])).toEqual([
      ['‹run›', RUN],
      ['‹runs›', RUNS],
    ]);
  });
});

describe('shortenText', () => {
  test('replaces a backslash-recorded path in either spelling', () => {
    const forward = WORKTREE.replaceAll('\\', '/');
    const text = `cat "${forward}/src/a.rs" ${WORKTREE}\\b.rs`;
    const { parts, droppedCheckoutPrefix } = shortenText(text, tokens);
    expect(shown(parts)).toBe('cat "‹worktree›/src/a.rs" ‹worktree›\\b.rs');
    expect(droppedCheckoutPrefix).toBe(false);
    expect(restored(parts)).toBe(`cat "${WORKTREE}/src/a.rs" ${WORKTREE}\\b.rs`);
  });

  test("this run's directory wins over the directory of all runs; another run keeps its id", () => {
    const { parts } = shortenText(`ls ${RUN}\\plan.md ${RUNS}\\850af357\\triage.md`, tokens);
    expect(shown(parts)).toBe('ls ‹run›\\plan.md ‹runs›\\850af357\\triage.md');
  });

  test('leaves a sibling directory whose name only starts with a known path', () => {
    const text = `ls ${WORKTREE}-old/x ${WORKTREE}2 ${WORKTREE}`;
    expect(shown(shortenText(text, tokens).parts)).toBe(
      `ls ${WORKTREE}-old/x ${WORKTREE}2 ‹worktree›`
    );
  });

  test.each([
    `cd "${WORKTREE}" && `,
    `cd '${WORKTREE}' && `,
    `cd ${WORKTREE} && `,
    `cd "${WORKTREE.replaceAll('\\', '/')}" && `,
  ])('drops the leading %s', prefix => {
    const { parts, droppedCheckoutPrefix } = shortenText(`${prefix}git status`, tokens);
    expect(parts).toEqual(['git status']);
    expect(droppedCheckoutPrefix).toBe(true);
  });

  test('keeps a cd into anywhere but the checkout itself, and a cd that is not leading', () => {
    for (const text of [
      `cd "${WORKTREE}\\sub" && ls`,
      `cd "${WORKTREE}"; ls`,
      `ls && cd "${WORKTREE}" && ls`,
      `cd "${RUN}" && ls`,
    ]) {
      const { parts, droppedCheckoutPrefix } = shortenText(text, tokens);
      expect(droppedCheckoutPrefix).toBe(false);
      expect(restored(parts)).toBe(text);
    }
    expect(shown(shortenText(`cd "${WORKTREE}\\sub" && ls`, tokens).parts)).toBe(
      'cd "‹worktree›\\sub" && ls'
    );
  });

  test('returns the text unchanged when the run names no path', () => {
    const text = `cd "${WORKTREE}" && ls`;
    expect(shortenText(text, [])).toEqual({ parts: [text], droppedCheckoutPrefix: false });
    expect(shortenText('', tokens)).toEqual({ parts: [''], droppedCheckoutPrefix: false });
  });
});

describe('shortenText cut to a displayed length', () => {
  const text = `${WORKTREE}/abcdef`;

  test('cuts literal text at the limit and never splits a token', () => {
    expect(shown(shortenText(text, tokens, 13).parts)).toBe('‹worktree›/ab…');
    expect(shown(shortenText(text, tokens, 5).parts)).toBe('…');
    expect(shortenText(text, tokens, 17)).toEqual(shortenText(text, tokens));
  });

  test('counts a token by its name, not by the length of its path', () => {
    const value = `${RUN}/a ${WORKTREE}/b ${RUNS}/c`;
    expect(shown(shortenText(value, tokens, 26).parts)).toBe('‹run›/a ‹worktree›/b …');
    expect(shown(shortenText(value, tokens, 29).parts)).toBe('‹run›/a ‹worktree›/b ‹runs›/c');
  });

  test('cuts a value far longer than the limit the same way as a short one', () => {
    const start = `x ${WORKTREE}/a `;
    const long = start + `${RUN}/b `.repeat(20_000);
    expect(shown(shortenText(long, tokens, 20).parts)).toBe('x ‹worktree›/a ‹run›…');
    expect(shown(shortenText(`${start}tail`, tokens, 20).parts)).toBe('x ‹worktree›/a tail');
  });
});
