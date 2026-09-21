const DOCS_DIRECTORY = 'packages/docs-web/';
const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

/**
 * Paths that read as documentation but are build inputs, so changing one must run the suite.
 * Most Markdown in this repository is executable prompt or skill content rather than prose, and
 * the checks that guard it all live inside the job this decision can skip — so a bare `.md` test
 * would let a bundled-prompt edit skip the very check built to catch that drift.
 *
 * An entry ending in `/` matches a directory, anything else matches one file. Each is here
 * because a named check reads it:
 *   - `.archon/commands/`, `.archon/workflows/` are compiled into
 *     `packages/workflows/src/defaults/bundled-defaults.generated.ts` (`check:bundled`).
 *   - `.claude/skills/` is imported as text by `packages/cli/src/bundled-skill.ts`, so it is
 *     compiled into the CLI itself (`check:bundled-skill`).
 *   - `provider-capabilities.md` is generated from the providers' `capabilities.ts`
 *     (`check:capability-matrix`), and lives under the docs site without being prose.
 *   - `adding-a-community-provider.mdx` is read by
 *     `packages/providers/src/community/_template/capabilities.test.ts`, which asserts the page
 *     renders the capabilities template by reference instead of a hand-copied snapshot.
 *   - The docs manifest is copied by the Docker dependency layer.
 */
const BUILD_INPUTS = [
  '.archon/commands/',
  '.archon/workflows/',
  '.claude/skills/',
  'packages/docs-web/src/content/docs/reference/provider-capabilities.md',
  'packages/docs-web/src/content/docs/contributing/adding-a-community-provider.mdx',
  'packages/docs-web/package.json',
];

/**
 * Paths that are not documentation but that no check reads, so changing one cannot alter a test
 * or build outcome. The bar for an entry is the mirror of `BUILD_INPUTS`: nothing in `validate`,
 * no test, and no workflow consumes the file's CONTENTS. Verified per entry, and every match
 * found when this list was written was prose in a comment or a fixture string literal.
 *
 * Deliberately absent, each because a named check reads it: `Dockerfile` and friends plus
 * `.dockerignore` (the `docker-build` job), `.prettierrc`/`.prettierignore` (`format:check`),
 * `homebrew/archon.rb` (`build:checksums`), `scripts/install.ps1` (`test:install`), the web
 * assets that feed the Docker image, and anything under `.github/workflows/` — changing the
 * gate must run the gate.
 *
 * An entry ending in `/` matches a directory, anything else matches one file.
 */
const INERT_PATHS = [
  '.gitignore',
  '.gitattributes',
  'LICENSE',
  '.env.example',
  'Caddyfile.example',
  '.archon/config.example.yaml',
  'assets/',
];

const isInert = (file: string): boolean =>
  INERT_PATHS.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));

const isBuildInput = (file: string): boolean =>
  BUILD_INPUTS.some(input => (input.endsWith('/') ? file.startsWith(input) : file === input));

export function shouldRunTestSuite(files: Iterable<string>): boolean {
  for (const file of files) {
    if (isBuildInput(file)) return true;
    if (isInert(file) || file.endsWith('.md') || file.startsWith(DOCS_DIRECTORY)) continue;
    return true;
  }
  return false;
}

/**
 * Files this change introduces, via a MERGE-BASE (three-dot) diff.
 *
 * Two-dot `git diff A B` reports every difference between the commits, so on a `pull_request`
 * it also reports commits that landed on the base branch after the branch point and attributes
 * them to the PR. One stray `.ts` path is enough to force the suite, which silently disabled
 * this filter for any PR opened against a moving branch. Three-dot compares against the merge
 * base, so it reports only what the branch itself changed.
 *
 * Correct for `push` too: `before` is an ancestor of `after`, so it is its own merge base and
 * the two forms agree. Exported so a test can exercise the diff mode rather than only the
 * pure decision below — a correct decision behind a wrong diff is exactly what shipped here.
 *
 * `repo` defaults to the process working directory, which is what the workflow runs in. It is a
 * parameter because this function's answer depends entirely on which repository it reads.
 */
export function changedFilesBetween(base: string, head: string, repo = process.cwd()): string[] {
  const result = Bun.spawnSync(
    ['git', 'diff', '--name-only', '--no-renames', `${base}...${head}`],
    {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not read changed files: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().split('\n').filter(Boolean);
}

/**
 * A force-push leaves `github.event.before` naming a commit that is no longer reachable, so the
 * diff fails for a reason that says nothing about what changed. Run the suite rather than guess:
 * an unnecessary run costs minutes, a wrong skip merges unchecked code. The cause goes to stderr
 * so the job log explains why the suite ran.
 *
 * Only the scan is caught. A bad argument is a wiring bug with no safe answer, so it stays a
 * throw and takes the step down with it.
 */
function decideFromDiff(base: string, head: string): boolean {
  try {
    return shouldRunTestSuite(changedFilesBetween(base, head));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    console.error(`Could not compare ${base}..${head}, so the test suite runs: ${cause}`);
    return true;
  }
}

function main(): void {
  const [eventName, base, head] = process.argv.slice(2);
  if (eventName === 'workflow_dispatch') {
    console.log('true');
    return;
  }
  if ((eventName !== 'push' && eventName !== 'pull_request') || !base || !head) {
    throw new Error(`Unsupported GitHub event: ${eventName ?? '(missing)'}`);
  }
  if (base === EMPTY_GIT_SHA) {
    console.log('true');
    return;
  }
  console.log(decideFromDiff(base, head));
}

if (import.meta.main) main();
