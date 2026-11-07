/**
 * Runs a deliver pack script as the engine does (a Bun subprocess reading
 * `INPUTS_*`) against a fake or real `archon forge`.
 *
 * By default the forge is a stateful fake: a preload that replaces `Bun.spawnSync`
 * for `archon forge` argv only, so it behaves the same on every platform. It keeps
 * one mutable pull request, one issue, the tracker's other issues and their
 * comments, so a write and the read-back that follows it see the same state.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from './temp-roots';

export const PACK = resolve(import.meta.dir, '../../workflows/sdlc');
export const SCRIPTS = join(PACK, 'deliver/scripts');

/**
 * The host Archon CLI argv, from `ARCHON_CLI_COMMAND` (a JSON string array), the contract a
 * workflow run gives pack scripts. The pack may not reach into the engine's source, so the
 * test runner names the CLI: `scripts/repo-tests.ts` sets it for root runs when it is unset.
 */
export function hostCli(): string[] {
  const value = process.env.ARCHON_CLI_COMMAND;
  if (!value) {
    throw new Error(
      'pack tests run the Archon CLI named by ARCHON_CLI_COMMAND; run them with `bun run test --plan pack`'
    );
  }
  return JSON.parse(value) as string[];
}
export const PR = { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 };
export const PR_URL = 'https://ghe.example.com/example/repo/pull/42';

/** One conversation comment on the tracker. */
export interface TrackerComment {
  readonly id: number;
  readonly body: string;
  /** The issue it is on; omitted for the pull request. */
  readonly issue?: number;
  /** The author's login; omitted reports no author. */
  readonly author?: string;
}

/** The pull request the fake forge reports, before any write in the run. */
export interface TrackerPr {
  readonly title?: string;
  readonly body?: string;
  readonly isDraft?: boolean;
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly baseRefName?: string;
  /** The head repository's owner; omitted, the head is in the pull request's repository. */
  readonly headRepositoryOwner?: { readonly login: string };
}

/** The starting state of the stateful fake forge. */
export interface TrackerFake {
  readonly issueLabels?: readonly string[];
  readonly repositoryLabels?: readonly string[];
  /** A refusal message for `pr.ready` and `pr.draft`; omit for a flip that succeeds. */
  readonly readyFail?: string;
  /** The pull request every `pr.view` reports. */
  readonly pr?: TrackerPr;
  /** No pull request matches a head lookup until one is created. */
  readonly noOpenPr?: boolean;
  /** Existing comments, in listing order. */
  readonly comments?: readonly TrackerComment[];
  /** A refusal message for every write. */
  readonly writeFail?: string;
  /** Drop every write instead of applying it, so the plugin's read-back disagrees. */
  readonly writeLost?: boolean;
  /** Existing tracker issues; `workitem.create` appends to them. */
  readonly issues?: readonly TrackerIssue[];
  /** The issue the run is about; number 7 by default. Labels come from `issueLabels`. */
  readonly issue?: TrackerSubject;
}

/** The issue the run is about. */
export interface TrackerSubject {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string;
  /** The author's login; null for a deleted account. */
  readonly author?: string | null;
  readonly state?: 'open' | 'closed';
  /** Why a closed issue was closed. */
  readonly state_reason?: string;
}

/** One other issue the fake forge knows. */
export interface TrackerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'CLOSED';
  /** A pull request, which shares the issue numbering. */
  readonly pull?: boolean;
}

export type ForgeFake =
  /** The stateful fake forge, seeded from `tracker`. The default. */
  | { readonly kind: 'state' }
  /** No `ARCHON_CLI_COMMAND` at all. */
  | { readonly kind: 'no-host' }
  /** The real CLI with a scratch Archon home whose config holds this `forge:` section. */
  | { readonly kind: 'home'; readonly config: Readonly<Record<string, unknown>> }
  /**
   * This exact host command, as the CLI and server would publish it. With
   * `fakeForge`, its `forge` operations are answered by the stateful fake forge and
   * every other command reaches it.
   */
  | { readonly kind: 'command'; readonly argv: readonly string[]; readonly fakeForge?: boolean }
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
  /** Every `archon` argv the fake forge received. */
  readonly forge: readonly string[];
  /** Every JSON request body the fake forge was handed through `--data-file`. */
  readonly forgeRequests: readonly string[];
  /** Every issue the fake forge created, in order. */
  readonly createdIssues: readonly TrackerIssue[];
  /** Every comment the fake forge wrote, with the issue or pull request it is on. */
  readonly comments: readonly { readonly issue: number; readonly body: string }[];
  /** Every issue close the fake forge received. */
  readonly closes: readonly { readonly number: number; readonly state: string; readonly state_reason: string }[];
  /** Every issue or pull request body the fake forge was asked to write, in order. */
  readonly bodies: readonly string[];
  /** The run's artifact directory, for a script that writes one. */
  readonly artifacts: string;
}

/** Fails the test when the script spawned `gh`: no pack script may call it. */
function refuseGhSpawns(ghLog: string): void {
  const spawned = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim() : '';
  if (spawned !== '') throw new Error(`the pack script spawned gh: ${spawned.split('\n').join('; ')}`);
}

/** A Bun preload that records and refuses every `gh` spawn. */
function ghGuardPreload(ghLog: string): string {
  return `{
const guarded = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[0] !== 'gh') return guarded(argv, settings);
  require('node:fs').appendFileSync(${JSON.stringify(ghLog)}, argv.slice(1).join(' ') + '\\n');
  return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('pack scripts never call gh') };
} });
}
`;
}

/**
 * A Bun preload that answers `archon forge <op>` from one in-memory tracker, logging
 * each argv to `forgeLog` and each request to `requestLog`. Every write reads back as
 * the plugin's does: `writeFail` refuses it, `writeLost` reports a failed read-back.
 */
function fakeForgePreload(fake: TrackerFake, logs: { forge: string; requests: string; side: string }): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
// \`comments\` stays at the top level: a test's own preload may read it. Everything
// else is block-scoped, so a test preload can reuse any other name.
const comments = (${JSON.stringify(fake.comments ?? [])}).map(row => ({ ...row }));
{
const fake = ${JSON.stringify(fake)};
const logs = ${JSON.stringify(logs)};
const original = Bun.spawnSync.bind(Bun);
const pr = {
  number: 42, title: 'A title', body: 'A body', isDraft: true, state: 'OPEN',
  headRefName: 'feature', headRefOid: 'deadbeef', baseRefName: 'dev',
  maintainerCanModify: null, ...(fake.pr ?? {}),
};
const subject = { number: 7, title: 'An issue', body: 'An issue body', author: 'someone', state: 'open', ...(fake.issue ?? {}) };
const issues = (fake.issues ?? []).map(row => ({ ...row }));
let exists = fake.noOpenPr !== true;
let nextId = 900;
const labels = new Set(fake.repositoryLabels ?? ['operator', 'archon-blocked', 'area']);
let issueLabels = [...(fake.issueLabels ?? ['operator', 'archon-blocked'])];
const side = (kind, value) => appendFileSync(logs.side + '.' + kind, JSON.stringify(value) + '\\n');
const done = value => ({ ok: true, value });
const refused = (op, message) => ({ ok: false, op, outcome: 'refused', message });
function write(op, apply, value) {
  if (fake.writeFail !== undefined) return refused(op, fake.writeFail);
  if (fake.writeLost) return { ok: false, op, outcome: 'verification_failed', message: 'the write did not read back' };
  apply();
  return done({ outcome: 'applied', ...value() });
}
function record(repo) {
  const owner = pr.headRepositoryOwner?.login;
  return {
    schemaVersion: 1, repo, number: pr.number,
    url: 'https://' + repo.host + '/' + repo.path + '/pull/' + String(pr.number),
    head: pr.headRefName, base: pr.baseRefName, is_draft: pr.isDraft, state: pr.state.toLowerCase(),
    head_repo: owner === undefined ? repo : { host: repo.host, path: owner + '/' + repo.path.split('/')[1] },
    head_revision: pr.headRefOid, base_revision: null, maintainer_can_modify: pr.maintainerCanModify,
  };
}
const issueUrl = (repo, n) => 'https://' + repo.host + '/' + repo.path + '/issues/' + String(n);
function commentUrl(repo, row) {
  const item = row.issue === undefined ? '/pull/' + String(pr.number) : '/issues/' + String(row.issue);
  return 'https://' + repo.host + '/' + repo.path + item + '#issuecomment-' + String(row.id);
}
function view(ref) {
  if (ref.number === subject.number) {
    return done({
      ref, kind: 'issue', title: subject.title, body: subject.body, state: subject.state,
      url: issueUrl(ref.repo, subject.number), labels: [...new Set(issueLabels)].map(name => ({ name })),
      ...(subject.author === undefined ? {} : { author: subject.author === null ? null : { login: subject.author } }),
    });
  }
  const other = issues.find(row => row.number === ref.number);
  if (other === undefined) return refused('workitem.view', 'not found');
  const url = issueUrl(ref.repo, other.number);
  return done({
    ref, kind: other.pull ? 'pr' : 'issue', title: other.title, body: other.body,
    state: other.state.toLowerCase(), url: other.pull ? url.replace('/issues/', '/pull/') : url,
    labels: [], author: { login: 'someone' },
  });
}
function upsert(op, repo, onIssue, marker, body) {
  if (body.split(/\\r?\\n/, 1)[0] !== marker) return refused(op, 'the body must begin with its marker');
  const marked = comments.filter(row => row.issue === onIssue && row.body.split(/\\r?\\n/, 1)[0] === marker);
  if (marked.length > 1) return refused(op, 'more than one comment carries the marker');
  let row = marked[0];
  if (row !== undefined && row.body === body) return done({ outcome: 'applied', changed: false, comment: { url: commentUrl(repo, row) } });
  return write(op, () => {
    if (row !== undefined) row.body = body;
    else { row = { id: nextId++, body, ...(onIssue === undefined ? {} : { issue: onIssue }) }; comments.push(row); }
    side('comments', { issue: onIssue ?? pr.number, body });
  }, () => ({ comment: { url: commentUrl(repo, row) } }));
}
function answer(op, request) {
  switch (op) {
    case 'workitem.view': return view(request.ref);
    case 'repo.labels.list': return done({ repo: request.repo, labels: [...labels].map(name => ({ name })) });
    case 'repo.label.ensure': return write(op, () => labels.add(request.name), () => ({}));
    case 'workitem.label.add': return write(op, () => issueLabels.push(request.name), () => ({}));
    case 'workitem.label.remove': return write(op, () => { issueLabels = issueLabels.filter(name => name !== request.name); }, () => ({}));
    case 'workitem.create': {
      const marked = issues.filter(row => !row.pull && row.body.split(/\\r?\\n/, 1)[0] === request.marker);
      if (marked.length > 1) return refused(op, 'more than one issue carries the marker');
      const found = marked[0];
      if (found !== undefined) {
        return done({ outcome: 'applied', changed: false, workitem: { kind: 'issue', ref: { repo: request.repo, number: found.number }, url: issueUrl(request.repo, found.number) } });
      }
      const number = 100 + issues.length;
      return write(op, () => {
        issues.push({ number, title: request.title, body: request.body, state: 'OPEN' });
        side('issues', issues[issues.length - 1]);
      }, () => ({ workitem: { kind: 'issue', ref: { repo: request.repo, number }, url: issueUrl(request.repo, number) } }));
    }
    case 'workitem.close': {
      if (subject.state === 'closed') {
        return subject.state_reason === request.reason
          ? done({ outcome: 'applied', changed: false, workitem: { state: 'closed' }, reason: request.reason })
          : refused(op, 'the issue is already closed for another reason');
      }
      return write(op, () => {
        side('closes', { number: subject.number, state: 'closed', state_reason: request.reason });
        subject.state = 'closed';
        subject.state_reason = request.reason;
      }, () => ({ workitem: { state: 'closed' }, reason: request.reason }));
    }
    case 'workitem.edit-body': return write(op, () => { side('bodies', request.body); subject.body = request.body; }, () => ({}));
    case 'workitem.comment.upsert': {
      const onIssue = request.subject.kind === 'pr' ? undefined : request.subject.ref.number;
      return upsert(op, request.subject.ref.repo, onIssue, request.marker, request.body);
    }
    case 'comment.upsert': return upsert(op, request.ref.repo, undefined, request.marker, request.body);
    case 'workitem.comments': {
      const ref = request.subject.ref;
      const onIssue = request.subject.kind === 'pr' ? undefined : ref.number;
      return done({
        workitem: { ref },
        comments: comments.filter(row => row.issue === onIssue).map(row => ({
          id: String(row.id), url: commentUrl(ref.repo, row), body: row.body,
          author: row.author === undefined ? null : { login: row.author },
        })),
      });
    }
    case 'pr.view': {
      const selector = request.selector;
      if (selector.kind === 'head') {
        const found = exists && (selector.state === 'any' || pr.state === 'OPEN') && pr.headRefName === selector.head;
        return done(found ? { pr: record(selector.repo), title: pr.title, body: pr.body } : null);
      }
      return done({ pr: record(selector.ref.repo), title: pr.title, body: pr.body });
    }
    case 'pr.create': return write(op, () => {
      pr.isDraft = request.draft;
      pr.title = request.title;
      pr.body = request.body;
      pr.headRefName = request.head;
      pr.headRefOid = request.headRevision;
      pr.baseRefName = request.base;
      pr.state = 'OPEN';
      exists = true;
    }, () => ({ pr: record(request.repo) }));
    case 'pr.edit-body': return write(op, () => { side('bodies', request.body); pr.body = request.body; }, () => ({ pr: record(request.ref.repo) }));
    case 'pr.ready':
    case 'pr.draft': {
      if (fake.readyFail !== undefined) return refused(op, fake.readyFail);
      return write(op, () => { pr.isDraft = op === 'pr.draft'; }, () => ({ pr: record(request.ref.repo) }));
    }
    default: return refused(op, 'the fake forge has no ' + op);
  }
}
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  const command = JSON.parse(process.env.ARCHON_CLI_COMMAND || '[]');
  const forgeCall = command.length > 0 && command.every((part, index) => argv[index] === part) && argv[command.length] === 'forge';
  if (!forgeCall) return original(argv, settings);
  const rest = argv.slice(command.length);
  appendFileSync(logs.forge, rest.join(' ') + '\\n');
  const op = rest[1];
  const dataFile = rest.indexOf('--data-file');
  const raw = dataFile >= 0 ? readFileSync(rest[dataFile + 1], 'utf8') : rest[rest.indexOf('--data') + 1];
  if (dataFile >= 0) appendFileSync(logs.requests, raw + '\\n');
  const result = answer(op, JSON.parse(raw));
  const response = result.ok
    ? { operationId: 'op-' + op, ok: true, result: { op, value: result.value } }
    : { operationId: 'op-' + op, ok: false, error: { kind: 'forge_error', message: result.message }, mutation: { op, outcome: result.outcome } };
  return { exitCode: result.ok ? 0 : 1, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.from('') };
} });
}
`;
}

export interface ScriptOptions {
  /** Additional subprocess preload code; `{ARTIFACTS}` resolves as in inputs. */
  readonly preload?: string;
  /** The stateful fake forge's starting state. */
  readonly tracker?: TrackerFake;
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
  /** Command-line arguments, for a script an agent runs rather than a node; `{ARTIFACTS}` resolves as in inputs. */
  readonly args?: readonly string[];
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
      runPackScriptIn(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-pack-script-'))), relative, options),
  };
}

/** The env that points a script's `archon forge` calls at the chosen forge. */
function forgeEnv(
  root: string,
  forge: ForgeFake,
  logs: { forge: string; requests: string; reads: string }
): Record<string, string> {
  if (forge.kind === 'no-host') return { ARCHON_CLI_COMMAND: '' };
  // Never executed: the preload answers every `forge` call under this command.
  if (forge.kind === 'state') return { ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, join(root, 'fake-forge')]) };
  if (forge.kind === 'command') return { ARCHON_CLI_COMMAND: JSON.stringify(forge.argv) };
  if (forge.kind === 'home') {
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.yaml'), JSON.stringify({ forge: forge.config }));
    return { ARCHON_CLI_COMMAND: JSON.stringify(hostCli()), ARCHON_HOME: home, HOME: home, ARCHON_TELEMETRY_DISABLED: '1' };
  }
  const cli = join(root, 'fake-archon.ts');
  const responses = forge.response === undefined ? null : typeof forge.response === 'string' ? [forge.response] : forge.response;
  writeFileSync(
    cli,
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logs.forge)}, argv.join(' ') + '\\n');
const dataFile = argv.indexOf('--data-file');
if (dataFile >= 0) appendFileSync(${JSON.stringify(logs.requests)}, readFileSync(argv[dataFile + 1], 'utf8') + '\\n');
const responses = ${JSON.stringify(responses)};
if (responses === null) { process.stderr.write('plugin unavailable'); process.exitCode = 1; }
else {
  const reads = existsSync(${JSON.stringify(logs.reads)}) ? Number(readFileSync(${JSON.stringify(logs.reads)}, 'utf8')) : 0;
  writeFileSync(${JSON.stringify(logs.reads)}, String(reads + 1));
  const chosen = JSON.parse(responses[Math.min(reads, responses.length - 1)]);
  process.stdout.write(JSON.stringify(chosen));
  process.exitCode = chosen.ok === true ? ${String(forge.okExitCode ?? 0)} : 1;
}
`
  );
  return { ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]) };
}

function runPackScriptIn(root: string, relative: string, options: ScriptOptions): ScriptRun {
  const sideLog = join(root, 'tracker');
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
  const forge = options.forge ?? { kind: 'state' };
  const stateful = forge.kind === 'state' || (forge.kind === 'command' && forge.fakeForge === true);
  const preload = join(root, 'preload.ts');
  writeFileSync(
    preload,
    ghGuardPreload(ghLog) +
      (stateful ? fakeForgePreload(options.tracker ?? {}, { forge: forgeLog, requests: requestLog, side: sideLog }) : '') +
      resolveArtifacts(options.preload ?? '')
  );

  // The engine hands every exec node a typed-artifact listing; an empty one by default.
  const listing = join(root, 'typed-artifacts.json');
  writeFileSync(listing, JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] }));

  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUTS_'))),
    INPUTS_PR: JSON.stringify(forgePrRecord()),
    INPUTS_EXPECTED: '[]',
    ARTIFACTS_DIR: artifacts,
    TYPED_ARTIFACTS_FILE: listing,
    ...Object.fromEntries(
      Object.entries(options.inputs ?? {}).map(([key, value]) => [key, resolveArtifacts(value)])
    ),
  };
  Object.assign(env, forgeEnv(root, forge, { forge: forgeLog, requests: requestLog, reads: readsLog }));

  // Parent env files must not reintroduce workflow inputs omitted by the fixture.
  const result = spawnSync(process.execPath, ['--no-env-file', '--preload', preload, join(PACK, `${relative}.ts`), ...(options.args ?? []).map(resolveArtifacts)], {
    cwd: options.cwd ?? root,
    env,
    encoding: 'utf8',
  });
  refuseGhSpawns(ghLog);
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
    forge: lines(forgeLog),
    forgeRequests: lines(requestLog),
    createdIssues: lines(`${sideLog}.issues`).map(line => JSON.parse(line) as TrackerIssue),
    comments: lines(`${sideLog}.comments`).map(line => JSON.parse(line) as ScriptRun['comments'][number]),
    closes: lines(`${sideLog}.closes`).map(line => JSON.parse(line) as ScriptRun['closes'][number]),
    bodies: lines(`${sideLog}.bodies`).map(line => JSON.parse(line) as string),
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

/** Every forge operation a run invoked, with the request it sent, in call order. */
export function forgeCalls(run: Pick<ScriptRun, 'forge' | 'forgeRequests'>): { op: string; request: Record<string, unknown> }[] {
  return run.forge.map((argv, index) => ({
    op: argv.split(' ')[1] ?? '',
    request: JSON.parse(run.forgeRequests[index] ?? '{}') as Record<string, unknown>,
  }));
}

/** The labels a run added to, and removed from, the issue numbered `number`. */
export function labelWrites(run: Pick<ScriptRun, 'forge' | 'forgeRequests'>, number: number): { add: string[]; remove: string[] } {
  const on = forgeCalls(run).filter(
    call => (call.request.subject as { ref?: { number?: number } } | undefined)?.ref?.number === number
  );
  const names = (op: string): string[] => on.filter(call => call.op === op).map(call => String(call.request.name));
  return { add: names('workitem.label.add'), remove: names('workitem.label.remove') };
}
