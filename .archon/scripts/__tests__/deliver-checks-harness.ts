/**
 * Runs a deliver pack script as the engine does (a Bun subprocess reading
 * `INPUTS_*`) against a fake `gh` and a fake or real `archon forge`.
 *
 * The fake `gh` is a preload that replaces `Bun.spawnSync` for `gh` argv only, so
 * it behaves the same on every platform. It keeps one mutable pull request and
 * one comment list, so a write and the read-back that follows it see the same
 * state — which is what makes an unverified write observable here at all. The
 * preload also makes the registration grace instant.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ChecksObservation } from '../../../packages/forge/src/operations';

export const PACK = resolve(import.meta.dir, '../../workflows/sdlc');
export const SCRIPTS = join(PACK, 'deliver/scripts');
export const CLI_ENTRY = resolve(import.meta.dir, '../../../packages/cli/src/cli.ts');
export const PR = { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 };
export const PR_URL = 'https://ghe.example.com/example/repo/pull/42';

const trackTempRoot = trackTempRoots();

/**
 * One row of `gh pr checks --json name,state,bucket`, as gh 2.92 prints it.
 * `state` is a check run's conclusion once it completes, its status before
 * that, or a commit status's own state; `bucket` is gh's collapse of `state`
 * (cli/cli pkg/cmd/pr/checks/aggregate.go).
 */
export interface GhCheckRow {
  readonly name: string;
  readonly state: string;
  readonly bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
}

/** One row of `gh api .../issues/<n>/comments`. */
export interface GhCommentRow {
  readonly id: number;
  readonly body: string;
}

/** The pull request `gh pr view --json` reports, before any write in the run. */
export interface GhPr {
  readonly title?: string;
  readonly body?: string;
  readonly isDraft?: boolean;
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly baseRefName?: string;
}

export interface GhFake {
  /**
   * What `gh pr checks --json` knows about each check; the fake prints only the
   * fields the reader requests. 'fail' prints no document and exits 1.
   */
  readonly checks?: readonly GhCheckRow[] | 'fail';
  /** `statusCheckRollup | length`; 'fail' exits 1. */
  readonly rollup?: number | 'fail';
  /** Active Actions workflow count, printed one id per line; 'fail' exits 1. */
  readonly workflows?: number | 'fail';
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
  /** The run's artifact directory, for a script that writes one. */
  readonly artifacts: string;
}

/**
 * A Bun preload that fakes `gh` for one script run and logs every gh argv to
 * `ghLog`. Shared with the bundled-pack test so both fake the same boundary.
 */
export function fakeGhPreload(fake: GhFake, ghLog: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
const fake = ${JSON.stringify(fake)};
const original = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'sleepSync', { value: () => {} });
const pr = {
  number: 42, title: 'A title', body: 'A body', isDraft: true, state: 'OPEN',
  headRefName: 'feature', headRefOid: 'deadbeef', baseRefName: 'dev',
  maintainerCanModify: null, ...(fake.pr ?? {}),
};
let comments = (fake.comments ?? []).map(row => ({ ...row }));
let exists = fake.noOpenPr !== true;
let nextId = 900;
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
      ...pr,
      url: 'https://' + host + '/' + path + '/pull/' + String(pr.number),
      headRepository: { name },
      headRepositoryOwner: { login: owner },
    };
    return Object.fromEntries(fields.map(field => [field, row[field]]));
  };
  if (text.startsWith('pr checks')) {
    if (fake.checks === undefined || fake.checks === 'fail')
      return result(1, '', fake.checks === 'fail' ? 'HTTP 502' : 'no checks reported');
    const fields = argv[argv.indexOf('--json') + 1].split(',');
    const rows = fake.checks.map(check => Object.fromEntries(fields.map(field => [field, check[field]])));
    // gh exits 1 on a failing bucket and 8 on a pending one, and prints the document either way.
    const code = fake.checks.some(check => check.bucket === 'fail') ? 1
      : fake.checks.some(check => check.bucket === 'pending') ? 8 : 0;
    return result(code, JSON.stringify(rows));
  }
  if (text.includes('statusCheckRollup'))
    return fake.rollup === 'fail' || fake.rollup === undefined ? result(1, '', 'HTTP 502') : result(0, String(fake.rollup));
  // Real gh refuses this combination before any request (gh 2.92).
  if (argv.includes('--slurp') && (argv.includes('--jq') || argv.includes('--template')))
    return result(1, '', 'the \`--slurp\` option is not supported with \`--jq\` or \`--template\`');
  if (text.startsWith('pr ready')) {
    if (fake.readyFail !== undefined) return result(1, '', fake.readyFail);
    if (!fake.writeLost) pr.isDraft = false;
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
  if (text.startsWith('pr view')) return result(0, JSON.stringify(project()));
  if (text.startsWith('api')) {
    const endpoint = argv.find(part => part.startsWith('repos/'));
    if (endpoint === undefined) return result(95, '', 'unexpected gh api call');
    if (endpoint.includes('/actions/workflows'))
      return fake.workflows === 'fail' || fake.workflows === undefined
        ? result(1, '', 'HTTP 404')
        // With --paginate, gh applies --jq to each page; the fake prints one id per active workflow.
        : result(0, Array.from({ length: fake.workflows }, (_, index) => index + 1 + '\\n').join(''));
    // gh api names its host with --hostname and its repository in the endpoint.
    const apiHost = argv[argv.indexOf('--hostname') + 1];
    const apiPath = endpoint.split('/').slice(1, 3).join('/');
    const url = (id) => 'https://' + apiHost + '/' + apiPath + '/pull/' + String(pr.number) + '#issuecomment-' + String(id);
    const method = argv.includes('--method') ? argv[argv.indexOf('--method') + 1] : 'GET';
    if (method === 'GET') {
      const page = Number(new URLSearchParams(endpoint.split('?')[1] ?? '').get('page') ?? '1');
      const rows = page === 1 ? comments.map(row => ({ ...row, html_url: url(row.id) })) : [];
      return result(0, JSON.stringify(rows));
    }
    if (fake.writeFail !== undefined) return result(1, '', fake.writeFail);
    const body = JSON.parse(readFileSync(argv[argv.indexOf('--input') + 1], 'utf8')).body;
    const id = method === 'PATCH' ? Number(endpoint.split('/').pop()) : nextId++;
    if (!fake.writeLost) {
      const existing = comments.find(row => row.id === id);
      if (existing) existing.body = body;
      else comments.push({ id, body });
    }
    return result(0, JSON.stringify({ id, body, html_url: url(id) }));
  }
  return result(95, '', 'unexpected gh call');
} });
`;
}

export interface ScriptOptions {
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
}

/** Run one pack script the way the engine does: `<pack>/<relative>.ts`. */
export function runPackScript(relative: string, options: ScriptOptions = {}): ScriptRun {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-pack-script-')));
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
  const resolveArtifacts = (value: string): string =>
    value.split('{ARTIFACTS}').join(artifactPath);
  for (const [name, content] of Object.entries(options.artifacts ?? {})) {
    writeFileSync(join(artifacts, name), resolveArtifacts(content));
  }
  const preload = join(root, 'preload.ts');
  writeFileSync(preload, fakeGhPreload(options.gh ?? {}, ghLog));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INPUTS_PR: JSON.stringify(PR),
    ARTIFACTS_DIR: artifacts,
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
    cwd: root,
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
    artifacts,
  };
}

export function runDeliverScript(
  script: 'check-ci' | 'ci-note' | 'flip-ready',
  options: ScriptOptions = {}
): ScriptRun {
  return runPackScript(`deliver/scripts/${script}`, options);
}

type ForgeState = 'none' | 'pending' | 'green' | 'red' | 'gated' | 'unknown';

/** A `checks.state` response in the forge wire shape, one unit per named state. */
export function forgeResponse(
  units: readonly { name: string; state: Exclude<ForgeState, 'none'> }[],
  options: { revision?: string; required?: typeof units | null } = {}
): string {
  const set = (list: typeof units): Pick<ChecksObservation, 'units' | 'summary'> => {
    const counts = { total: list.length, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 };
    for (const unit of list) counts[unit.state]++;
    const state =
      (['red', 'gated', 'unknown', 'pending', 'green'] as const).find(key => counts[key] > 0) ??
      'none';
    return {
      units: list.map(unit => ({
        unit: { kind: 'check', id: unit.name, name: unit.name },
        nativeState: unit.state,
        phase: unit.state === 'pending' ? 'running' : 'completed',
        nativeResult: unit.state,
        result: unit.state === 'green' ? 'success' : unit.state === 'pending' ? null : 'failure',
        state: unit.state,
      })),
      summary: { state, counts },
    };
  };
  return JSON.stringify({
    operationId: 'op-checks',
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref: PR,
        revision: options.revision ?? 'deadbeef',
        ...set(units),
        required: options.required ? set(options.required) : null,
      },
    },
  });
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
