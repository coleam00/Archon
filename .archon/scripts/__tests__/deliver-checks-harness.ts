/**
 * Runs a deliver pack check script as the engine does (a Bun subprocess reading
 * `INPUTS_PR`) against a fake `gh` and a fake or real `archon forge checks`.
 *
 * The fake `gh` is a preload that replaces `Bun.spawnSync` for `gh` argv only, so
 * it behaves the same on every platform. The preload also makes the registration
 * grace instant.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ChecksObservation } from '../../../packages/forge/src/operations';

export const SCRIPTS = resolve(import.meta.dir, '../../workflows/sdlc/deliver/scripts');
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
  /** `gh pr view --json state`; omit to make that read fail. */
  readonly prState?: string;
}

export type ForgeFake =
  /** No `ARCHON_CLI_COMMAND` at all. */
  | { readonly kind: 'no-host' }
  /** The real CLI with an empty Archon home: no forge plugin is installed. */
  | { readonly kind: 'no-plugin' }
  /** A fake CLI that prints this document, or fails when `response` is omitted. */
  | { readonly kind: 'fake'; readonly response?: string | readonly string[] };

export interface ScriptRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every `gh` argv, space-joined, in call order. */
  readonly gh: readonly string[];
  /** Every `archon` argv the fake CLI received. */
  readonly forge: readonly string[];
}

/**
 * A Bun preload that fakes `gh` for one script run and logs every gh argv to
 * `ghLog`. Shared with the bundled-pack test so both fake the same boundary.
 */
export function fakeGhPreload(fake: GhFake, ghLog: string): string {
  return `import { appendFileSync } from 'node:fs';
const fake = ${JSON.stringify(fake)};
const original = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'sleepSync', { value: () => {} });
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[0] !== 'gh') return original(argv, settings);
  const text = argv.slice(1).join(' ');
  appendFileSync(${JSON.stringify(ghLog)}, text + '\\n');
  // gh appends an update notice to stderr on successful calls too.
  const result = (exitCode, stdout = '', stderr = 'gh: A new release of gh is available') =>
    ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
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
  // With --paginate, gh applies --jq to each page; the fake prints one id per active workflow.
  if (text.startsWith('api'))
    return fake.workflows === 'fail' || fake.workflows === undefined
      ? result(1, '', 'HTTP 404')
      : result(0, Array.from({ length: fake.workflows }, (_, index) => index + 1 + '\\n').join(''));
  if (text.startsWith('pr ready'))
    return fake.readyFail === undefined ? result(0, 'ready') : result(1, '', fake.readyFail);
  if (text.includes('--json isDraft')) return result(0, 'false');
  if (text.includes('--json state')) return fake.prState === undefined ? result(1) : result(0, fake.prState);
  if (text.includes('--json url')) return result(0, ${JSON.stringify(PR_URL)});
  return result(95, '', 'unexpected gh call');
} });
`;
}

export function runDeliverScript(
  script: 'check-ci' | 'ci-note' | 'flip-ready',
  options: { source?: string; gh?: GhFake; forge?: ForgeFake } = {}
): ScriptRun {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `deliver-${script}-`)));
  const ghLog = join(root, 'gh.log');
  const forgeLog = join(root, 'forge.log');
  const readsLog = join(root, 'forge-reads');
  const preload = join(root, 'preload.ts');
  writeFileSync(preload, fakeGhPreload(options.gh ?? {}, ghLog));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INPUTS_PR: JSON.stringify(PR),
    ARCHON_SDLC_FORGE: options.source ?? '',
    ARCHON_CLI_COMMAND: '',
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
appendFileSync(${JSON.stringify(forgeLog)}, process.argv.slice(2).join(' ') + '\\n');
const responses = ${JSON.stringify(responses ?? null)};
if (responses === null) { process.stderr.write('plugin unavailable'); process.exitCode = 1; }
else {
  const reads = existsSync(${JSON.stringify(readsLog)}) ? Number(readFileSync(${JSON.stringify(readsLog)}, 'utf8')) : 0;
  writeFileSync(${JSON.stringify(readsLog)}, String(reads + 1));
  process.stdout.write(responses[Math.min(reads, responses.length - 1)]);
}
`
    );
    env.ARCHON_CLI_COMMAND = JSON.stringify([process.execPath, cli]);
  }

  const result = spawnSync(process.execPath, ['--preload', preload, join(SCRIPTS, `${script}.ts`)], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const lines = (path: string): string[] =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line !== '') : [];
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    gh: lines(ghLog),
    forge: lines(forgeLog),
  };
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
