import { readFileSync } from 'node:fs';

const DOCS_DIRECTORY = 'packages/docs-web/';
const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

/**
 * Paths that read as documentation but are build inputs, so changing one must run
 * the auxiliary build and service jobs. Markdown in bundled prompts and skills is
 * executable content rather than ordinary prose.
 *
 * An entry ending in `/` matches a directory, anything else matches one file. Each is here
 * because a named check reads it:
 *   - Pack prompts (`commands/`) and `.shared/` documents under `.archon/workflows/` are
 *     compiled into `packages/workflows/src/defaults/bundled-defaults.generated.ts`
 *     (`check:bundled`) and read by pack tests; `isPackPrompt` matches them. Pack READMEs and
 *     design notes are prose. Every other file under `.archon/workflows/` is not Markdown, so
 *     it runs the suite anyway.
 *   - `.claude/skills/` is imported as text by `packages/cli/src/bundled-skill.ts`, so it is
 *     compiled into the CLI itself (CLI skill tests).
 *   - `provider-capabilities.md` is generated from the providers' `capabilities.ts`
 *     (`check:capability-matrix`), and lives under the docs site without being prose.
 *   - The docs manifest is copied by the Docker dependency layer.
 */
const BUILD_INPUTS = [
  '.claude/skills/',
  'packages/docs-web/src/content/docs/reference/provider-capabilities.md',
  'packages/docs-web/package.json',
];

/**
 * Paths that are not documentation but that no check reads, so changing one cannot alter a test
 * or build outcome. The bar for an entry is the mirror of `BUILD_INPUTS`: nothing in `validate`,
 * no test, and no workflow consumes the file's CONTENTS. Verified per entry, and every match
 * found when this list was written was prose in a comment or a fixture string literal.
 *
 * Deliberately absent, each because a named check reads it: `Dockerfile` and friends plus
 * `.dockerignore` (the `docker-build` job), `biome.jsonc` (`lint` and `format:check`),
 * `homebrew/archon.rb` (`build:checksums`), `scripts/install.ps1` (`test:install`), the web assets that feed the Docker image, and anything under
 * `.github/workflows/` — changing the gate must run the gate. `Caddyfile.example` is read by
 * `reverse-proxy.test.ts` and `caddy-recipe.test.ts`, and git applies `.gitattributes` to every
 * file a test reads from the checkout.
 *
 * An entry ending in `/` matches a directory, anything else matches one file.
 */
const INERT_PATHS = [
  '.gitignore',
  'LICENSE',
  '.env.example',
  '.archon/config.example.yaml',
  'assets/',
];

const isInert = (file: string): boolean =>
  INERT_PATHS.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));

const isPackPrompt = (file: string): boolean =>
  file.startsWith('.archon/workflows/') &&
  file.split('/').some(segment => segment === 'commands' || segment === '.shared');

const isBuildInput = (file: string): boolean =>
  isPackPrompt(file) ||
  BUILD_INPUTS.some(input => (input.endsWith('/') ? file.startsWith(input) : file === input));

export function shouldRunTestSuite(files: Iterable<string>): boolean {
  for (const file of files) {
    if (isBuildInput(file)) return true;
    if (isInert(file) || file.endsWith('.md') || file.startsWith(DOCS_DIRECTORY)) continue;
    return true;
  }
  return false;
}

export function shouldRunWorkflowFixtures(files: Iterable<string>): boolean {
  for (const path of files) {
    const file = path.replaceAll('\\', '/');
    if (
      file.startsWith('.archon/workflows/sdlc/') ||
      file.startsWith('packages/workflows/src/') ||
      file === 'packages/cli/src/commands/workflow.ts'
    )
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
    ['git', 'diff', '--name-only', '-z', '--no-renames', `${base}...${head}`],
    {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not read changed files: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().split('\0').filter(Boolean);
}

/**
 * A force-push leaves `github.event.before` naming a commit that is no longer reachable, so the
 * diff fails for a reason that says nothing about what changed. Run the suite rather than guess:
 * an unnecessary run costs minutes, a wrong skip merges unchecked code. The cause goes to stderr
 * so the job log explains why the suite ran.
 *
 * Only the scan is caught. A bad event is a wiring bug with no safe answer, so it stays a
 * throw and takes the step down with it.
 */
function decideFromDiff(
  base: string,
  head: string,
  predicate: (files: Iterable<string>) => boolean
): boolean {
  try {
    return predicate(changedFilesBetween(base, head));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    console.error(`Could not compare ${base}..${head}, so the selected checks run: ${cause}`);
    return true;
  }
}

/** The parts of a GitHub event payload this reads. Every leaf is checked before use. */
export interface EventPayload {
  before?: unknown;
  after?: unknown;
  pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } } | null;
}

/** The commits to compare, or `null` when there is nothing to compare and the suite runs. */
export type DiffRange = { base: string; head: string } | null;

function requireSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`The GitHub event payload has no ${field}`);
  }
  return value;
}

/**
 * Which commits decide the run, read from the event payload rather than chosen in the workflow.
 *
 * A pull request is judged on its whole diff: PR base to PR head, which the merge-base diff
 * turns into "everything this branch changes". Never on the previous push alone: a
 * `synchronize` payload also carries `before`, the previous push's head, and judging by it let a
 * docs-only push cancel the run a code push had started (the workflow's concurrency group
 * cancels the older run) and then skip the suite, leaving the PR head untested.
 *
 * A push spans `before` to `after`. Its suite decision comes from `proofFromPullRequestRun`, and
 * only the fixture decision still reads the push diff. A push that creates a branch has an
 * all-zero `before`, so there is nothing to compare.
 */
export function diffRange(eventName: string, event: EventPayload): DiffRange {
  if (eventName === 'workflow_dispatch') return null;
  if (eventName === 'pull_request') {
    return {
      base: requireSha(event.pull_request?.base?.sha, 'pull_request.base.sha'),
      head: requireSha(event.pull_request?.head?.sha, 'pull_request.head.sha'),
    };
  }
  if (eventName === 'push') {
    const base = requireSha(event.before, 'before');
    if (base === EMPTY_GIT_SHA) return null;
    return { base, head: requireSha(event.after, 'after') };
  }
  throw new Error(`Unsupported GitHub event: ${eventName}`);
}

/** A GitHub REST GET; `path` is relative to `repos/{owner}/{repo}/`. */
export type GitHubGet = (path: string) => Promise<unknown>;

export type PushProof = { proven: true; evidence: string } | { proven: false; reason: string };

/** The workflow that runs this script, whose pull request runs can prove a push. */
const TEST_WORKFLOW = 'test.yml';

function field(value: unknown, key: string, what: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return (value as Record<string, unknown>)[key];
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is not a string`);
  return value;
}

/**
 * Whether a pull request run already passed every job on exactly the tree this push lands, so
 * running the suite again would retest it. All four must hold:
 *   1. a pull request was merged as `head`, the pushed commit;
 *   2. that pull request's head contains its recorded `base.sha`. A `pull_request` run tests the
 *      merge ref, not the head, and GitHub records the base it merged with as the pull request's
 *      `base.sha` when the head is pushed. A head that contains that base makes the merge ref's
 *      tree the head's tree. The branch's previous tip is no substitute: after a reset of the
 *      branch it can lack commits the run's merge ref contained. Retargeting the base also
 *      rewrites `base.sha` but starts no run, so a run from before a retarget goes undetected;
 *   3. the pushed commit and the pull request head have the same tree;
 *   4. a successful `pull_request` run of `test.yml` at that head concluded `success` in every
 *      job of its latest attempt. A prose-only run skipped its gated jobs, so it proves nothing
 *      and its push runs the suite: that is where the tests that read prose run.
 *
 * Any failure to read the evidence is "not proven": an unnecessary run costs minutes, a wrong
 * skip merges unchecked code.
 */
export async function proofFromPullRequestRun(
  push: { head: string },
  get: GitHubGet
): Promise<PushProof> {
  try {
    const pulls = list(await get(`commits/${push.head}/pulls`), 'the commit pull list');
    const pull = pulls.find(
      candidate => field(candidate, 'merge_commit_sha', 'a pull request') === push.head
    );
    if (pull === undefined) {
      return { proven: false, reason: `no pull request was merged as ${push.head}` };
    }
    const number = field(pull, 'number', 'the pull request');
    const prHead = text(
      field(field(pull, 'head', 'the pull request'), 'sha', 'its head'),
      'head.sha'
    );

    const prBase = text(
      field(field(pull, 'base', 'the pull request'), 'sha', 'its base'),
      'base.sha'
    );

    const status = field(await get(`compare/${prBase}...${prHead}`), 'status', 'the comparison');
    if (status !== 'ahead' && status !== 'identical') {
      return {
        proven: false,
        reason: `pull request #${String(number)}'s head does not contain its base ${prBase} (${String(status)})`,
      };
    }

    const treeOf = async (sha: string): Promise<string> =>
      text(
        field(field(await get(`git/commits/${sha}`), 'tree', sha), 'sha', `${sha}'s tree`),
        'tree.sha'
      );
    const tree = await treeOf(push.head);
    if (tree !== (await treeOf(prHead))) {
      return {
        proven: false,
        reason: `the trees of ${push.head} and pull request #${String(number)}'s head ${prHead} differ`,
      };
    }

    const runs = list(
      field(
        await get(
          `actions/workflows/${TEST_WORKFLOW}/runs?head_sha=${prHead}&event=pull_request&status=success`
        ),
        'workflow_runs',
        'the run list'
      ),
      'workflow_runs'
    );
    if (runs.length === 0) {
      return {
        proven: false,
        reason: `no successful pull_request run of ${TEST_WORKFLOW} at ${prHead}`,
      };
    }
    const shortfalls: string[] = [];
    for (const run of runs) {
      const url = text(field(run, 'html_url', 'a run'), 'html_url');
      const page = await get(
        `actions/runs/${String(field(run, 'id', 'a run'))}/jobs?filter=latest&per_page=100`
      );
      const jobs = list(field(page, 'jobs', 'the job list'), 'jobs');
      const unpassed = jobs
        .map(job => ({
          name: String(field(job, 'name', 'a job')),
          conclusion: String(field(job, 'conclusion', 'a job')),
        }))
        .filter(job => job.conclusion !== 'success')
        .map(job => `${job.name}=${job.conclusion}`);
      if (field(page, 'total_count', 'the job list') !== jobs.length) {
        unpassed.push(
          `${String(field(page, 'total_count', 'the job list'))} jobs, ${jobs.length} read`
        );
      }
      if (unpassed.length === 0) {
        return {
          proven: true,
          evidence: `Pull request #${String(number)} run ${url} passed every job on tree ${tree}, so this push skips the suite.`,
        };
      }
      shortfalls.push(`run ${url} did not pass every job: ${unpassed.join(', ')}`);
    }
    return { proven: false, reason: shortfalls.join('; ') };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { proven: false, reason: `could not check pull request runs: ${cause}` };
  }
}

/** Reads the repository and token GitHub Actions provides. The token is never printed. */
function githubApi(env: NodeJS.ProcessEnv = process.env): GitHubGet {
  return async path => {
    const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_API_URL: api } = env;
    if (!token || !repository || !api) {
      throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_API_URL must all be set');
    }
    const response = await fetch(`${api}/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GET ${path} answered ${String(response.status)}`);
    return await response.json();
  };
}

/** Reads the event GitHub Actions names in `GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH`. */
async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--workflow-fixtures')) {
    throw new Error('Usage: bun scripts/should-run-test-suite.ts [--workflow-fixtures]');
  }
  const fixtures = args.length === 1;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) {
    throw new Error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must both be set');
  }
  const event: EventPayload = JSON.parse(readFileSync(eventPath, 'utf8'));
  const range = diffRange(eventName, event);
  if (range === null) {
    console.log(true);
    return;
  }
  if (eventName === 'push') {
    const proof = await proofFromPullRequestRun(range, githubApi());
    if (proof.proven) {
      console.error(proof.evidence);
      console.log(false);
      return;
    }
    console.error(`No pull request run proves this push: ${proof.reason}.`);
    // A push is never path-filtered for the suite; only fixtures still follow the push diff.
    if (!fixtures) {
      console.log(true);
      return;
    }
  }
  const predicate = fixtures ? shouldRunWorkflowFixtures : shouldRunTestSuite;
  console.log(decideFromDiff(range.base, range.head, predicate));
}

if (import.meta.main) await main();
