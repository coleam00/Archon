/**
 * Runs a deliver pack script as the engine does (a Bun subprocess reading
 * `INPUTS_*`) against a fake `gh` and a fake or real `archon forge`.
 *
 * The fake `gh` is a preload that replaces `Bun.spawnSync` for `gh` argv only, so
 * it behaves the same on every platform. It keeps one mutable pull request and
 * one comment list, so a write and the read-back that follows it see the same
 * state — which is what makes an unverified write observable here at all.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';

export const PACK = resolve(import.meta.dir, '../../workflows/sdlc');
export const SCRIPTS = join(PACK, 'deliver/scripts');
export const CLI_ENTRY = resolve(import.meta.dir, '../../../packages/cli/src/cli.ts');
export const PR = { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 };
export const PR_URL = 'https://ghe.example.com/example/repo/pull/42';

/** One row of `gh api .../issues/<n>/comments`. */
export interface GhCommentRow {
  readonly id: number;
  readonly body: string;
  /** The issue it is on; omitted for the pull request. */
  readonly issue?: number;
}

/** The pull request `gh pr view --json` reports, before any write in the run. */
export interface GhPr {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string;
  readonly isDraft?: boolean;
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly headRepository?: { readonly name: string };
  readonly headRepositoryOwner?: { readonly login: string };
  readonly baseRefName?: string;
}

export interface GhFake {
  readonly issueLabels?: readonly string[];
  readonly repositoryLabels?: readonly string[];
  /** stderr for a refused `gh pr ready`; omit for a flip that succeeds. */
  readonly readyFail?: string;
  /** The pull request every `gh pr view`/`gh pr list` read reports. */
  readonly pr?: GhPr;
  /** No pull request matches `gh pr list --head` until one is created. */
  readonly noOpenPr?: boolean;
  /** Existing issue comments, in listing order. */
  readonly comments?: readonly GhCommentRow[];
  /** stderr for a refused write (`pr create`, `pr edit`, or a comment write). */
  readonly writeFail?: string;
  /** Drop the write instead of applying it, so the read-back disagrees. */
  readonly writeLost?: boolean;
  /**
   * Existing tracker issues; `issue create` appends to them. `gh api` reads them
   * too, beside the one issue `issue` describes.
   */
  readonly issues?: readonly GhIssue[];
  /** The issue `gh api repos/<path>/issues/<n>` reads; number 7 by default. Labels come from `issueLabels`. */
  readonly issue?: GhApiIssue;
}

/** The issue facts `gh api .../issues/<n>` reports. */
export interface GhApiIssue {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string;
  /** The author's login; null for a deleted account. */
  readonly author?: string | null;
  readonly state?: 'open' | 'closed';
  /** Why a closed issue was closed. */
  readonly state_reason?: string;
  /**
   * The edit history `gh api graphql` reports; never edited when omitted. A null
   * `createdBody` is a creation revision that cannot be recovered (deleted).
   * `firstEditedBody` is an oldest revision made after creation, so not the creation body.
   */
  readonly history?: {
    readonly createdBody?: string | null;
    readonly firstEditedBody?: string;
    readonly createdTitle?: string;
  };
}

/** One tracker issue the fake gh knows. */
export interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'CLOSED';
  /** A pull request, which `gh issue view` also resolves by number. */
  readonly pull?: boolean;
}

export type ForgeFake =
  /** No `ARCHON_CLI_COMMAND` at all. */
  | { readonly kind: 'no-host' }
  /** The real CLI with an empty Archon home: no forge plugin is installed. */
  | { readonly kind: 'no-plugin' }
  /** This exact host command, as the CLI and server would publish it. */
  | { readonly kind: 'command'; readonly argv: readonly string[] }
  /** A fake CLI that prints this document, or fails when `response` is omitted. */
  | {
      readonly kind: 'fake';
      readonly response?: string | readonly string[];
      /**
       * The exit status for a successful response. The real CLI exits 2 when the
       * operation completed and only its run audit could not be persisted.
       */
      readonly okExitCode?: number;
    };

export interface ScriptRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every `gh` argv, space-joined, in call order. */
  readonly gh: readonly string[];
  /** Every `archon` argv the fake CLI received. */
  readonly forge: readonly string[];
  /** Every JSON request body the fake CLI was handed through `--data-file`. */
  readonly forgeRequests: readonly string[];
  /** Every issue the fake gh created, in order. */
  readonly createdIssues: readonly GhIssue[];
  /** Every comment the fake gh wrote, with the issue or pull request it is on. */
  readonly comments: readonly { readonly issue: number; readonly body: string }[];
  /** Every issue state change the fake gh received. */
  readonly closes: readonly { readonly number: number; readonly state: string; readonly state_reason: string }[];
  /** The run's artifact directory, for a script that writes one. */
  readonly artifacts: string;
}

/**
 * A Bun preload that fakes `gh` for one script run and logs every gh argv to
 * `ghLog`.
 */
function fakeGhPreload(fake: GhFake, ghLog: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
const fake = ${JSON.stringify(fake)};
const original = Bun.spawnSync.bind(Bun);
const pr = {
  number: 42, title: 'A title', body: 'A body', isDraft: true, state: 'OPEN',
  headRefName: 'feature', headRefOid: 'deadbeef', baseRefName: 'dev',
  maintainerCanModify: null, ...(fake.pr ?? {}),
};
let comments = (fake.comments ?? []).map(row => ({ ...row }));
const subject = { number: 7, title: 'An issue', body: 'An issue body', author: 'someone', state: 'open', ...(fake.issue ?? {}) };
const issues = (fake.issues ?? []).map(row => ({ ...row }));
let exists = fake.noOpenPr !== true;
let nextId = 900;
const labels = new Set(fake.repositoryLabels ?? ['operator', 'archon-blocked', 'area']);
let issueLabels = [...(fake.issueLabels ?? ['operator', 'archon-blocked'])];
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[0] !== 'gh') return original(argv, settings);
  const text = argv.slice(1).join(' ');
  appendFileSync(${JSON.stringify(ghLog)}, text + '\\n');
  // gh appends an update notice to stderr on successful calls too.
  const result = (exitCode, stdout = '', stderr = 'gh: A new release of gh is available') =>
    ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
  const selector = argv[argv.indexOf('--repo') + 1] ?? 'github.com/owner/repo';
  const host = selector.split('/')[0];
  const path = selector.split('/').slice(1).join('/');
  const owner = path.split('/')[0];
  const name = path.split('/')[1];
  const project = () => {
    const fields = argv[argv.indexOf('--json') + 1].split(',');
    const row = {
      url: 'https://' + host + '/' + path + '/pull/' + String(pr.number),
      headRepository: { name },
      headRepositoryOwner: { login: owner },
      ...pr,
    };
    return Object.fromEntries(fields.map(field => [field, row[field]]));
  };
  if (text.startsWith('label list')) return result(0, JSON.stringify([...labels].map(name => ({ name }))));
  if (text.startsWith('label create')) { if (fake.writeFail) return result(1, '', fake.writeFail); labels.add(argv[3]); return result(0); }
  if (text.startsWith('issue edit')) {
    if (fake.writeFail) return result(1, '', fake.writeFail);
    if (!fake.writeLost) for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--add-label') issueLabels.push(argv[index + 1]);
      if (argv[index] === '--remove-label') issueLabels = issueLabels.filter(name => name !== argv[index + 1]);
    }
    return result(0);
  }
  if (text.startsWith('issue ')) {
    const issueUrl = (n) => 'https://' + host + '/' + path + '/issues/' + String(n);
    if (text.startsWith('issue view')) {
      const wanted = Number(argv[3].split('/').pop());
      const row = issues.find(candidate => candidate.number === wanted);
      if (row === undefined) return result(1, '', 'GraphQL: Could not resolve to an issue');
      const url = row.pull ? issueUrl(row.number).replace('/issues/', '/pull/') : issueUrl(row.number);
      return result(0, JSON.stringify({ title: row.title, state: row.state, url }));
    }
    if (text.startsWith('issue create')) {
      if (fake.writeFail) return result(1, '', fake.writeFail);
      const number = 100 + issues.length;
      issues.push({
        number,
        title: fake.writeLost ? 'different' : argv[argv.indexOf('--title') + 1],
        body: readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8'),
        state: 'OPEN',
      });
      appendFileSync(${JSON.stringify(ghLog)} + '.issues', JSON.stringify(issues[issues.length - 1]) + '\\n');
      return result(0, issueUrl(number));
    }
  }
  // Real gh refuses this combination before any request (gh 2.92).
  if (argv.includes('--slurp') && (argv.includes('--jq') || argv.includes('--template')))
    return result(1, '', 'the \`--slurp\` option is not supported with \`--jq\` or \`--template\`');
  if (text.startsWith('pr ready')) {
    if (fake.readyFail !== undefined) return result(1, '', fake.readyFail);
    if (!fake.writeLost) pr.isDraft = argv.includes('--undo');
    return result(0, 'ready');
  }
  if (text.startsWith('pr create')) {
    if (fake.writeFail !== undefined) return result(1, '', fake.writeFail);
    if (!fake.writeLost) {
      pr.isDraft = argv.includes('--draft');
      pr.title = argv[argv.indexOf('--title') + 1];
      pr.body = readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8');
      pr.headRefName = (argv[argv.indexOf('--head') + 1] ?? pr.headRefName).split(':').pop();
      pr.baseRefName = argv[argv.indexOf('--base') + 1] ?? pr.baseRefName;
      pr.state = 'OPEN';
      exists = true;
    }
    return result(0, 'https://' + host + '/' + path + '/pull/' + String(pr.number));
  }
  if (text.startsWith('pr edit')) {
    if (fake.writeFail !== undefined) return result(1, '', fake.writeFail);
    if (!fake.writeLost) pr.body = readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8');
    return result(0, '');
  }
  if (text.startsWith('pr list')) {
    // gh applies the head and state filters server side.
    const listed = exists && pr.state === 'OPEN' && pr.headRefName === argv[argv.indexOf('--head') + 1];
    return result(0, JSON.stringify(listed ? [project()] : []));
  }
  if (text.startsWith('pr view') && argv.includes('--jq')) return result(0, String(pr.headRefOid));
  if (text.startsWith('pr view')) return result(0, JSON.stringify(project()));
  if (text.startsWith('api graphql')) {
    const history = fake.issue?.history ?? {};
    const createdAt = '2026-01-01T00:00:00Z';
    const nodes = history.firstEditedBody !== undefined
      ? [{ editedAt: '2026-02-01T00:00:00Z', diff: history.firstEditedBody }]
      : history.createdBody === undefined ? []
      : [{ editedAt: createdAt, diff: history.createdBody }];
    return result(0, JSON.stringify({ data: { repository: { issue: {
      createdAt,
      userContentEdits: { totalCount: nodes.length === 0 ? 0 : 2, nodes },
      timelineItems: { nodes: history.createdTitle === undefined ? [] : [{ previousTitle: history.createdTitle }] },
    } } } }));
  }
  if (text.startsWith('api')) {
    const endpoint = argv.find(part => part.startsWith('repos/'));
    if (endpoint === undefined) return result(95, '', 'unexpected gh api call');
    // gh api names its host with --hostname and its repository in the endpoint.
    const apiHost = argv[argv.indexOf('--hostname') + 1];
    const apiPath = endpoint.split('/').slice(1, 3).join('/');
    // A comment row without an issue number is on the pull request.
    const commentUrl = (row) => 'https://' + apiHost + '/' + apiPath + (row.issue === undefined ? '/pull/' + String(pr.number) : '/issues/' + String(row.issue)) + '#issuecomment-' + String(row.id);
    const issueUrl = (n) => 'https://' + apiHost + '/' + apiPath + '/issues/' + String(n);
    const method = argv.includes('--method') ? argv[argv.indexOf('--method') + 1] : 'GET';
    const input = () => JSON.parse(readFileSync(argv[argv.indexOf('--input') + 1], 'utf8'));
    if (endpoint.endsWith('/issues/' + String(subject.number))) {
      if (method === 'PATCH') {
        if (fake.writeFail !== undefined) return result(1, '', fake.writeFail);
        const field = (name) => argv.find(part => part.startsWith(name + '='))?.slice(name.length + 1);
        const change = { state: field('state'), state_reason: field('state_reason') };
        appendFileSync(${JSON.stringify(ghLog)} + '.closes', JSON.stringify({ number: subject.number, ...change }) + '\\n');
        if (!fake.writeLost) { subject.state = change.state; subject.state_reason = change.state_reason; }
      }
      return result(0, JSON.stringify({
        number: subject.number, title: subject.title, body: subject.body, state: subject.state,
        state_reason: subject.state_reason ?? null,
        user: subject.author === null ? null : { login: subject.author },
        html_url: issueUrl(subject.number),
        labels: [...new Set(issueLabels)].map(name => ({ name })),
      }));
    }
    const other = issues.find(row => endpoint.endsWith('/issues/' + String(row.number)));
    if (other !== undefined) return result(0, JSON.stringify({
      number: other.number, title: other.title, body: other.body, state: other.state.toLowerCase(),
      user: { login: 'someone' },
      html_url: other.pull ? issueUrl(other.number).replace('/issues/', '/pull/') : issueUrl(other.number),
      labels: [],
      ...(other.pull ? { pull_request: {} } : {}),
    }));
    const parts = endpoint.split('?')[0].split('/');
    const commentsOn = parts.at(-1) === 'comments' && parts.at(-3) === 'issues' ? Number(parts.at(-2)) : pr.number;
    const onIssue = commentsOn === pr.number ? undefined : commentsOn;
    if (method === 'GET') {
      const page = Number(new URLSearchParams(endpoint.split('?')[1] ?? '').get('page') ?? '1');
      const rows = page === 1 ? comments.filter(row => row.issue === onIssue).map(row => ({ id: row.id, body: row.body, html_url: commentUrl(row) })) : [];
      return result(0, JSON.stringify(rows));
    }
    if (fake.writeFail !== undefined) return result(1, '', fake.writeFail);
    const body = input().body;
    const id = method === 'PATCH' ? Number(endpoint.split('/').pop()) : nextId++;
    let row = comments.find(entry => entry.id === id);
    if (!fake.writeLost) {
      if (row) row.body = body;
      else { row = { id, body, ...(onIssue === undefined ? {} : { issue: onIssue }) }; comments.push(row); }
    }
    appendFileSync(${JSON.stringify(ghLog)} + '.comments', JSON.stringify({ issue: row?.issue ?? onIssue ?? pr.number, body }) + '\\n');
    return result(0, JSON.stringify({ id, body, html_url: commentUrl(row ?? { id, issue: onIssue }) }));
  }
  return result(95, '', 'unexpected gh call');
} });
`;
}

export interface ScriptOptions {
  /** Additional subprocess preload code; `{ARTIFACTS}` resolves as in inputs. */
  readonly preload?: string;
  readonly source?: string;
  readonly gh?: GhFake;
  readonly forge?: ForgeFake;
  /**
   * `INPUTS_*` values this script reads, beyond the recorded pull request.
   * `{ARTIFACTS}` in a value is replaced with the run's artifact directory.
   */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Files to write under the run's artifact directory, with the same substitution. */
  readonly artifacts?: Readonly<Record<string, string>>;
  /** The script's working directory, for one that reads a git checkout. Defaults to a scratch directory. */
  readonly cwd?: string;
}

export interface PackScriptRunner {
  /** Run one pack script the way the engine does: `<pack>/<relative>.ts`. */
  readonly runPackScript: (relative: string, options?: ScriptOptions) => ScriptRun;
}

/**
 * The script runner for one test file. Call it once at the file's module scope.
 *
 * The scratch roots are tracked here rather than at this module's top level because a
 * hook registered while a shared module is first imported belongs to that one test
 * file. Every later file in the same `bun test` process would leak all of its roots.
 */
export function packScriptRunner(): PackScriptRunner {
  const trackTempRoot = trackTempRoots();
  return {
    runPackScript: (relative, options = {}) =>
      runPackScriptIn(
        trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-pack-script-'))),
        relative,
        options
      ),
  };
}

function runPackScriptIn(root: string, relative: string, options: ScriptOptions): ScriptRun {
  const ghLog = join(root, 'gh.log');
  const forgeLog = join(root, 'forge.log');
  const requestLog = join(root, 'forge-requests');
  const readsLog = join(root, 'forge-reads');
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  // A substituted path also travels inside JSON artifacts, where a Windows
  // separator is an invalid string escape. Forward slashes resolve on every
  // platform and survive JSON.parse.
  const artifactPath = artifacts.split(sep).join('/');
  const resolveArtifacts = (value: string): string => value.split('{ARTIFACTS}').join(artifactPath);
  for (const [name, content] of Object.entries(options.artifacts ?? {})) {
    mkdirSync(dirname(join(artifacts, name)), { recursive: true });
    writeFileSync(join(artifacts, name), resolveArtifacts(content));
  }
  const preload = join(root, 'preload.ts');
  writeFileSync(
    preload,
    fakeGhPreload(options.gh ?? {}, ghLog) + resolveArtifacts(options.preload ?? '')
  );

  // The engine hands every exec node a typed-artifact listing; an empty one by default.
  const listing = join(root, 'typed-artifacts.json');
  writeFileSync(listing, JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INPUTS_PR: JSON.stringify(forgePrRecord()),
    INPUTS_EXPECTED: '[]',
    ARTIFACTS_DIR: artifacts,
    TYPED_ARTIFACTS_FILE: listing,
    ARCHON_SDLC_FORGE: options.source ?? '',
    ARCHON_CLI_COMMAND: '',
    ...Object.fromEntries(
      Object.entries(options.inputs ?? {}).map(([key, value]) => [key, resolveArtifacts(value)])
    ),
  };
  const forge = options.forge ?? { kind: 'fake' };
  if (forge.kind === 'no-plugin') {
    const home = join(root, 'home');
    mkdirSync(home);
    Object.assign(env, {
      ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, '--no-env-file', CLI_ENTRY]),
      ARCHON_HOME: home,
      HOME: home,
      ARCHON_TELEMETRY_DISABLED: '1',
    });
  } else if (forge.kind === 'command') {
    env.ARCHON_CLI_COMMAND = JSON.stringify(forge.argv);
  } else if (forge.kind === 'fake') {
    const cli = join(root, 'fake-archon.ts');
    const responses =
      forge.response === undefined
        ? undefined
        : typeof forge.response === 'string'
          ? [forge.response]
          : forge.response;
    writeFileSync(
      cli,
      `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(forgeLog)}, argv.join(' ') + '\\n');
const dataFile = argv.indexOf('--data-file');
if (dataFile >= 0) appendFileSync(${JSON.stringify(requestLog)}, readFileSync(argv[dataFile + 1], 'utf8') + '\\n');
const responses = ${JSON.stringify(responses ?? null)};
if (responses === null) { process.stderr.write('plugin unavailable'); process.exitCode = 1; }
else {
  const reads = existsSync(${JSON.stringify(readsLog)}) ? Number(readFileSync(${JSON.stringify(readsLog)}, 'utf8')) : 0;
  writeFileSync(${JSON.stringify(readsLog)}, String(reads + 1));
  const chosen = JSON.parse(responses[Math.min(reads, responses.length - 1)]);
  process.stdout.write(JSON.stringify(chosen));
  process.exitCode = chosen.ok === true ? ${String(forge.okExitCode ?? 0)} : 1;
}
`
    );
    env.ARCHON_CLI_COMMAND = JSON.stringify([process.execPath, cli]);
  }

  const result = spawnSync(process.execPath, ['--preload', preload, join(PACK, `${relative}.ts`)], {
    cwd: options.cwd ?? root,
    env,
    encoding: 'utf8',
  });
  const lines = (path: string): string[] =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter(line => line !== '')
      : [];
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    gh: lines(ghLog),
    forge: lines(forgeLog),
    forgeRequests: lines(requestLog),
    createdIssues: lines(`${ghLog}.issues`).map(line => JSON.parse(line) as GhIssue),
    comments: lines(`${ghLog}.comments`).map(line => JSON.parse(line) as ScriptRun['comments'][number]),
    closes: lines(`${ghLog}.closes`).map(line => JSON.parse(line) as ScriptRun['closes'][number]),
    artifacts,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A checkout on a feature branch whose remote, named `upstream` and configured with
 * the recorded repository's URL, is a local bare repository (`url.insteadOf`), so a
 * script finds the remote by URL and fetches the base without a network. With
 * `conflict`, the base has since changed the same line the feature changed. `track`
 * owns the temp root's removal: pass the calling test file's own `trackTempRoots()`.
 */
export function gitCheckout(
  options: { readonly conflict?: boolean },
  track: (root: string) => string
): string {
  const root = track(mkdtempSync(join(tmpdir(), 'archon-pack-git-')));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'dev', bare]);
  spawnSync('git', ['init', '-q', '-b', 'dev', work]);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'remote', 'add', 'upstream', `https://${PR.repo.host}/${PR.repo.path}.git`);
  git(work, 'config', `url.${bare}.insteadOf`, `https://${PR.repo.host}/${PR.repo.path}.git`);
  writeFileSync(join(work, 'a.txt'), 'base\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'upstream', 'dev');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, 'a.txt'), 'feature\n');
  git(work, 'commit', '-q', '-am', 'feature');
  if (options.conflict === true) {
    git(work, 'checkout', '-q', 'dev');
    writeFileSync(join(work, 'a.txt'), 'moved base\n');
    git(work, 'commit', '-q', '-am', 'base moved');
    git(work, 'push', '-q', 'upstream', 'dev');
    git(work, 'checkout', '-q', 'feature');
  }
  return work;
}

/** A verified pull-request record in the forge wire shape. */
export function forgePrRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repo: PR.repo,
    number: PR.number,
    url: PR_URL,
    head: 'feature',
    base: 'dev',
    is_draft: true,
    state: 'open',
    head_repo: PR.repo,
    head_revision: 'deadbeef',
    base_revision: 'cafe',
    maintainer_can_modify: null,
    ...overrides,
  };
}

/** One forge operation response document, as the CLI prints it. */
export function forgeOperation(op: string, value: unknown): string {
  return JSON.stringify({ operationId: `op-${op}`, ok: true, result: { op, value } });
}

/** One failed forge operation, with the mutation evidence a write owes its caller. */
export function forgeFailure(
  op: string,
  outcome: 'refused' | 'verification_failed' | 'outcome_unknown',
  message: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    operationId: `op-${op}`,
    ok: false,
    error: { kind: 'forge_error', message },
    mutation: { op, target: PR, outcome, ...extra },
  });
}
