/**
 * Runs the checks `discover` declared, in order, and records what happened.
 *
 * Every exit status lands in `$ARTIFACTS_DIR/validation.md`, rewritten after each
 * check so the record is current if the node is stopped. Each check's full output
 * goes to its own log under `$ARTIFACTS_DIR/validation/`. Checks belong to groups
 * the discovering agent declared: independent gates are separate groups. Within a
 * group the first failing check ends that group — later ones are recorded as never
 * run, which is how a project's own aggregate gate behaves — but every group runs,
 * so one gate's failure never hides another's result. A project with one gate has
 * one group and behaves exactly as a single ordered chain.
 *
 * The status is read from exit statuses alone:
 * - `red`: every check that should run did, and one exited non-zero or was killed by
 *   a signal it did not get from this script. `classify` judges why.
 * - `incomplete`: a check could not be started, so part of the gate never ran; any
 *   check that did fail is named in the summary.
 * - `green`: every declared check ran and exited 0. No declared checks is green only
 *   because `discover` judged that the project defines none; its notes say so.
 *
 * No timer lives here. The node's `timeout:` is the only one, and the engine stops
 * this script with SIGTERM when it expires. The handler below then stops the
 * running check's whole process tree, records the stop, and re-raises the signal
 * so the engine sees a timeout rather than a result.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { projectEnvironment } from '../../.shared/node-env.ts';

interface Check {
  name: string;
  argv: string[];
  group: string;
}

export interface Discovery {
  checks: Check[];
  notes: string;
}

type Outcome =
  | { kind: 'passed' }
  | { kind: 'failed'; exitCode: number | null; signal: string | null }
  | { kind: 'not-started'; error: string }
  | { kind: 'stopped'; signal: string }
  | { kind: 'running' }
  | { kind: 'never-ran' };

interface Entry {
  check: Check;
  log: string;
  outcome: Outcome;
  seconds: number | null;
}

// `discover`'s output is certified against its node's schema before it is bound here.
const discovery = JSON.parse(text(process.env.INPUTS_DISCOVERY)) as Discovery;
const cwd = process.cwd();
const artifacts = artifactsDir();
const logDir = join(artifacts, 'validation');
const report = join(artifacts, 'validation.md');
// The checks run as the project's own gate, not as part of this run.
const gateEnv = projectEnvironment(process.env);

const TAIL_LINES = 60;

function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'passed':
      return 'passed (exit 0)';
    case 'failed':
      return outcome.signal === null
        ? `failed (exit ${String(outcome.exitCode)})`
        : `failed (killed by ${outcome.signal})`;
    case 'not-started':
      return `could not start: ${outcome.error}`;
    case 'stopped':
      return `did not finish: the node's time limit stopped it (${outcome.signal})`;
    case 'running':
      return 'running';
    case 'never-ran':
      return 'never ran';
  }
}

function tail(path: string): string {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  return lines.slice(-TAIL_LINES).join('\n');
}

function render(entries: readonly Entry[]): void {
  const groups = new Set(entries.map(entry => entry.check.group)).size;
  const lines = ['# Validation', ''];
  if (discovery.notes.trim() !== '') lines.push(discovery.notes.trim(), '');
  if (entries.length === 0) lines.push('The project defines no checks, so none ran.', '');
  for (const [index, entry] of entries.entries()) {
    const seconds = entry.seconds === null ? '' : ` after ${entry.seconds.toFixed(0)}s`;
    const group = groups > 1 ? ` (group: ${entry.check.group})` : '';
    lines.push(`## ${String(index + 1)}. ${entry.check.name}${group}`, '');
    lines.push(`\`${entry.check.argv.join(' ')}\` ${describe(entry.outcome)}${seconds}.`);
    const kind = entry.outcome.kind;
    if (kind === 'failed' || kind === 'stopped' || kind === 'not-started') {
      const output = tail(entry.log);
      if (output !== '') {
        lines.push('', `Last ${String(TAIL_LINES)} lines of output:`, '', '```', output, '```');
      }
    }
    if (kind !== 'never-ran' && kind !== 'not-started')
      lines.push('', `Full output: \`${entry.log}\``);
    lines.push('');
  }
  writeFileSync(report, `${lines.join('\n').trimEnd()}\n`);
}

const entries: Entry[] = discovery.checks.map((check, index) => ({
  check,
  log: join(logDir, `${String(index + 1)}.log`),
  outcome: { kind: 'never-ran' },
  seconds: null,
}));
let current: { entry: Entry; child: ChildProcess; started: number } | null = null;

// POSIX only: a detached child leads its own process group, so one signal reaches
// every process the check started. Windows has no process groups, and the engine
// ends a timed-out script there without a signal this handler could catch.
const ownGroup = process.platform !== 'win32';

function stopCurrent(signal: NodeJS.Signals): void {
  if (current === null) return;
  const { entry, child, started } = current;
  entry.outcome = { kind: 'stopped', signal };
  entry.seconds = (Date.now() - started) / 1000;
  if (child.pid === undefined) return;
  try {
    if (ownGroup) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // The group already exited between its last output and this signal.
  }
}

function onSignal(signal: NodeJS.Signals): void {
  stopCurrent(signal);
  render(entries);
  // Re-raise with default handling, so the engine sees the node stopped by its
  // signal. Exiting normally here would read to the engine as a finished run.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

function runOne(entry: Entry): Promise<void> {
  const fd = openSync(entry.log, 'w');
  const started = Date.now();
  return new Promise<void>(resolve => {
    const [command, ...args] = entry.check.argv;
    const child = spawn(command, args, {
      cwd,
      env: gateEnv,
      stdio: ['ignore', fd, fd],
      detached: ownGroup,
    });
    current = { entry, child, started };
    entry.outcome = { kind: 'running' };
    render(entries);
    // A command that cannot be spawned reports `error` and may or may not also
    // report `close`; whichever settles the check first wins.
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      current = null;
      closeSync(fd);
      entry.seconds = (Date.now() - started) / 1000;
      if (entry.outcome.kind === 'running') entry.outcome = outcome;
      resolve();
    };
    child.once('error', error => {
      settle({ kind: 'not-started', error: error.message });
    });
    child.once('close', (exitCode, signal) => {
      settle(exitCode === 0 ? { kind: 'passed' } : { kind: 'failed', exitCode, signal });
    });
  });
}

interface Result {
  status: 'green' | 'red' | 'incomplete';
  summary: string;
}

async function runGate(): Promise<Result> {
  const stoppedGroups = new Set<string>();
  for (const entry of entries) {
    if (stoppedGroups.has(entry.check.group)) continue;
    await runOne(entry);
    if (entry.outcome.kind !== 'passed') stoppedGroups.add(entry.check.group);
  }
  render(entries);

  const failures = entries.filter(entry => entry.outcome.kind === 'failed');
  const unstarted = entries.find(entry => entry.outcome.kind === 'not-started');
  const passed = entries
    .filter(entry => entry.outcome.kind === 'passed')
    .map(entry => entry.check.name);
  const ranPassed = passed.length === 0 ? 'No check passed.' : `Passed: ${passed.join(', ')}.`;

  const failed = failures.map(entry => `${entry.check.name} ${describe(entry.outcome)}`).join('; ');
  // A check that could not start leaves part of the gate unrun, so the result is
  // unfinished even when another group failed: a red verdict would read as complete.
  if (unstarted !== undefined) {
    return {
      status: 'incomplete',
      summary: `${unstarted.check.name} ${describe(unstarted.outcome)}. ${ranPassed} Later checks in its group never ran.${failed === '' ? '' : ` Failed: ${failed}.`}`,
    };
  }
  if (failures.length > 0) return { status: 'red', summary: `${failed}. ${ranPassed} See validation.md.` };
  if (entries.length === 0) {
    return { status: 'green', summary: `No checks defined by this project. ${discovery.notes}`.trim() };
  }
  return { status: 'green', summary: `Every check passed: ${passed.join(', ')}.` };
}

mkdirSync(logDir, { recursive: true });
emit(await runGate());
