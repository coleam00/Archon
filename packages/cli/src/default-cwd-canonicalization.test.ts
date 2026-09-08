/**
 * Seam lock for `remote_agent_codebases.default_cwd` (#2927).
 *
 * The column is matched by exact string equality, so it only works while every
 * writer and every reader turns a filesystem path into that string with the
 * SAME function. That invariant used to live in prose — two comments each
 * claiming to "mirror" the other — and it was false: the CLI/HTTP writer used
 * `fs/promises.realpath`, the CLI gate and the chat writer used
 * `fs.realpathSync`, and on Windows those disagree about 8.3 short names
 * (`C:\Users\RUNNER~1\…` vs `C:\Users\runneradmin\…`). Every folder project
 * registered by the CLI became invisible to every later command in that
 * directory, behind a false "Not in a git repository".
 *
 * A behavioural test cannot catch the recurrence on macOS or Linux, where all
 * the realpath variants agree — the second canonicalizer is invisible until it
 * reaches Windows. So this file locks the seam where it is actually visible: a
 * site that resolves a `default_cwd` path may reach `canonicalizeProjectPath`
 * and nothing else. Adding a second canonicalization means importing a realpath,
 * and importing a realpath fails here.
 *
 * @see packages/core/src/handlers/register-folder-lookup.integration.test.ts
 *      for the write-then-read round trip these files have to satisfy.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '..', '..', '..');

/** Every product site that turns a path into a `default_cwd` value. */
const CANONICALIZING_SITES = [
  // registerFolder — the CLI `workflow run --folder` and HTTP writer.
  'packages/core/src/handlers/clone.ts',
  // /register-project and /update-project — the chat writers.
  'packages/core/src/orchestrator/orchestrator-agent.ts',
  // The pre-dispatch project gate — the reader that decides whether a command
  // may run at all in a non-git directory.
  'packages/cli/src/cli-main.ts',
  // `archon doctor`'s folder-project check.
  'packages/cli/src/commands/doctor.ts',
] as const;

/**
 * Drop comments so a file may still explain the invariant in prose without
 * tripping the identifier check below.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('default_cwd canonicalization seam', () => {
  for (const relativePath of CANONICALIZING_SITES) {
    describe(relativePath, () => {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      const code = stripComments(source);

      it('resolves default_cwd through the shared canonicalizer', () => {
        expect(code).toContain('canonicalizeProjectPath');
        expect(code).toMatch(/from '@archon\/paths'/);
      });

      it('does not reach a realpath of its own', () => {
        // `canonicalizeProjectPath` owns the choice of realpath variant. A
        // second one here is the #2927 defect, whatever it is named.
        expect(code).not.toMatch(/\brealpath/i);
      });
    });
  }
});
