/**
 * Classify the current branch PR's check state, once.
 *
 * Archon-owned facts only (gh state, never the project's toolchain). This is the
 * single-shot probe inside the `await-checks` loop_group: the engine's durable
 * `wait:` node owns the time between probes and a concluded check signals it, so this
 * script never sleeps through CI — it reads the state, declares it, and exits.
 *
 * States, declared through this node's `output_format` so `when:` and `until_bash`
 * branch on a certified field rather than on prose:
 *   pending    checks exist and some are still running
 *   concluded  green, no CI configured, or CI gated on a maintainer's approval (fork
 *              or first contribution) — a gate only a maintainer can open, named,
 *              never blocked on and never called green
 *   red        concluded with non-green checks, named. `pass` counts, `skipping` is
 *              accepted as non-blocking, and everything else — `fail`, `cancel`, or
 *              any bucket this script does not recognize — is red. A cancelled check
 *              is not a green check (R4).
 *
 * Red is a report, never a verdict: this probe declares the state and the deliver
 * tail's convergence pass decides what it means — introduced red is correction work,
 * while inherited or environment red pauses for explicit operator action. Nothing here
 * retries: a concluded check does not re-run itself.
 *
 * The one in-process wait left: when CI is configured but nothing has started yet,
 * registration gets a single 60 s grace before the maintainer-gated skip is declared —
 * the same grace the polling predecessor gave it. #3155 owns the time BETWEEN probes,
 * not the case where no check has registered to signal anything.
 */

import { emit, refuse } from '../../.shared/io.ts';

interface Check {
  readonly name: string;
  readonly bucket: string;
}

interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function gh(...args: string[]): Ran {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function isCheck(value: unknown): value is Check {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.bucket === 'string';
}

/** `undefined` means the read itself failed and nothing may be concluded from it. */
function checks(): readonly Check[] | undefined {
  const result = gh('pr', 'checks', '--json', 'name,bucket');
  // A last-resort match on a vendor message, kept because gh has no structured way to
  // say "this PR has no checks": it exits non-zero with that sentence and an empty
  // stdout, which is otherwise indistinguishable from a failed read. Non-zero WITH
  // data still parses — gh exits 1 when checks failed.
  if (!result.ok && `${result.stdout}${result.stderr}`.toLowerCase().includes('no checks reported')) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    refuse(`check-ci: could not read check state: ${result.stderr.trim()}`);
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every(isCheck)) {
    refuse(`check-ci: unexpected check payload shape: ${result.stdout.slice(0, 200)}`);
    return undefined;
  }
  return parsed;
}

/** `undefined` means the answer could not be determined, which counts as configured. */
function repoHasActiveWorkflows(): boolean | undefined {
  const result = gh(
    'api',
    'repos/{owner}/{repo}/actions/workflows',
    '--jq',
    '[.workflows[] | select(.state == "active")] | length'
  );
  if (!result.ok) return undefined;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? undefined : count > 0;
}

function classify(rounds: readonly Check[]): void {
  const pending = rounds.filter(check => check.bucket === 'pending');
  if (pending.length > 0) {
    emit({ state: 'pending', detail: `${pending.length} check(s) running` });
    return;
  }

  const passed = rounds.filter(check => check.bucket === 'pass');
  const skipped = rounds.filter(check => check.bucket === 'skipping');
  const notGreen = rounds.filter(
    check => check.bucket !== 'pass' && check.bucket !== 'skipping'
  );

  if (notGreen.length > 0) {
    emit({
      state: 'red',
      detail: notGreen.map(check => `${check.name} (${check.bucket})`).join(', '),
    });
    return;
  }

  const note =
    skipped.length > 0
      ? `; skipped (non-blocking): ${skipped.map(check => check.name).join(', ')}`
      : '';
  emit({ state: 'concluded', detail: `all ${passed.length} required check(s) green${note}` });
}

const first = checks();
if (first !== undefined) {
  if (first.length > 0) {
    classify(first);
  } else if (repoHasActiveWorkflows() === false) {
    emit({
      state: 'concluded',
      detail: 'no checks configured on this repository — nothing to await',
    });
  } else {
    // CI exists (or could not be ruled out) but nothing started. Give registration one
    // grace interval, then skip with the reason: starting gated CI is a maintainer's
    // power, not this run's.
    Bun.sleepSync(60_000);
    const second = checks();
    if (second !== undefined) {
      if (second.length > 0) {
        classify(second);
      } else {
        emit({
          state: 'concluded',
          detail:
            'CI is configured but no checks started on this PR — most likely awaiting ' +
            "a maintainer's approval to run (fork or first contribution), or path filters. " +
            'Skipping the CI gate; running and verifying checks stays with the maintainer.',
        });
      }
    }
  }
}
