/**
 * The host CLI for queue and discoveries script tests: `workflow runs --json` answers from
 * the rows in `RUN_LISTING`, `workflow run <name>` acknowledges `launched-<name>` and
 * `trigger fire` a receipt whose binding was admitted as run `fired-run`, without
 * starting anything (either refuses, exit 1, when `ARCHON_RUN_REFUSES` is set); every
 * other command runs the real CLI, whose argv the test passes as a JSON array in
 * `INTAKE_HOST_CLI` (`ARCHON_CLI_COMMAND` names this fake).
 *
 * When `ARCHON_CALL_LOG` names a file, each call's argv is appended to it as a JSON line.
 *
 * The real CLI runs as a surface write, outside any run, in `INTAKE_STATE_CWD` when
 * set: inside a run it would refuse with exit 5, because its store has no such run. A
 * surface write cannot hold a lease either, so this fake keeps the documents' leases in
 * `$ARCHON_HOME/fake-leases.json` the way `archon state` reports them: `--lease` and
 * `--release-lease` act for `WORKFLOW_ID`, and a lease is live while its run's status in
 * `INTAKE_RUN_STATUSES` is neither `completed` nor `cancelled`. A run with no status
 * there counts as deleted, so its lease has ended.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeLeaseLive } from './fake-lease.ts';

const argv = process.argv.slice(2);
if (process.env.ARCHON_CALL_LOG) appendFileSync(process.env.ARCHON_CALL_LOG, `${JSON.stringify(argv)}\n`);
if (argv[0] === 'workflow' && argv[1] === 'runs') {
  // The project's run listing, from `RUN_LISTING` (a JSON array of run rows).
  const runs = JSON.parse(process.env.RUN_LISTING ?? '[]') as unknown[];
  process.stdout.write(JSON.stringify({ runs, total: runs.length, scopeFallback: false }));
} else if (argv[0] === 'workflow' && argv[1] === 'run') {
  if (process.env.ARCHON_RUN_REFUSES) {
    process.stderr.write('refused');
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify({ runId: `launched-${argv[2]}` }));
} else if (argv[0] === 'trigger' && argv[1] === 'fire') {
  if (process.env.ARCHON_RUN_REFUSES) {
    process.stderr.write('refused');
    process.exitCode = 1;
  } else {
    const disposition = { status: 'admitted', requestId: 'fired-run', runId: 'fired-run' };
    process.stdout.write(JSON.stringify({ bindings: [{ status: 'complete', disposition }] }));
  }
} else if (argv[0] === 'state') {
  state();
} else {
  const result = host(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

function host(args: readonly string[]) {
  if (!process.env.INTAKE_HOST_CLI) throw new Error('INTAKE_HOST_CLI names no host CLI');
  const [command, ...prefix] = JSON.parse(process.env.INTAKE_HOST_CLI) as string[];
  return spawnSync(command, [...prefix, ...args], {
    cwd: process.env.INTAKE_STATE_CWD || process.cwd(),
    env: { ...process.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    input: readFileSync(0),
    encoding: 'utf8',
  });
}

function live(runId: string): boolean {
  const statuses = JSON.parse(process.env.INTAKE_RUN_STATUSES ?? '{}') as Record<string, string>;
  return fakeLeaseLive(statuses[runId]);
}

/** The lease the documents' leases record after this successful write. */
function leaseAfter(op: string | undefined, holder: string | undefined, change: string | undefined): string | undefined {
  const self = process.env.WORKFLOW_ID ?? '';
  if (op === 'delete' || change === 'release') return undefined;
  if (change === 'take' && !(holder === self && live(self))) return self;
  return holder;
}

/** `state get` and `state list` output with each document's lease as `archon state` reports it. */
function withLeases(op: string | undefined, output: Record<string, unknown>, leases: Record<string, string>): Record<string, unknown> {
  const view = (name: unknown) => {
    const holder = typeof name === 'string' ? leases[name] : undefined;
    return holder === undefined ? null : { runId: holder, live: live(holder) };
  };
  if (op === 'get') return { ...output, lease: view(output.name) };
  if (op === 'list' && Array.isArray(output.documents))
    return { ...output, documents: output.documents.map(row => ({ ...(row as object), lease: view((row as { name?: unknown }).name) })) };
  return output;
}

function state(): void {
  // Declared here, not at module level: the dispatch above runs before later declarations.
  const file = join(process.env.ARCHON_HOME ?? '.', 'fake-leases.json');
  const leases = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, string>;
  const [, op, name] = argv;
  const change = argv.includes('--lease') ? 'take' : argv.includes('--release-lease') ? 'release' : undefined;
  const holder = name === undefined ? undefined : leases[name];
  if (change !== undefined && holder !== undefined && holder !== process.env.WORKFLOW_ID && live(holder)) {
    process.stdout.write(JSON.stringify({ ok: false, error: `leased by live run ${holder}`, code: 3 }));
    process.exitCode = 3;
    return;
  }
  const result = host(argv.filter(arg => arg !== '--lease' && arg !== '--release-lease'));
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    return;
  }
  if (name !== undefined) {
    const after = leaseAfter(op, holder, change);
    if (after === undefined) delete leases[name];
    else leases[name] = after;
    writeFileSync(file, JSON.stringify(leases));
  }
  process.stdout.write(JSON.stringify(withLeases(op, JSON.parse(result.stdout) as Record<string, unknown>, leases)));
}
