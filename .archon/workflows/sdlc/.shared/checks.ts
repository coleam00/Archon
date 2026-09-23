/**
 * The deliver pack's one pull-request check reader and its gate policy.
 *
 * Two sources return the same units, so `check-ci`, `ci-note` and `flip-ready`
 * classify one shape whichever source read it:
 *
 *   gh     the default. Reads the recorded pull request through the GitHub CLI.
 *   forge  opt-in with `ARCHON_SDLC_CHECKS=forge`. Reads through `archon forge
 *          checks`, which needs an installed forge plugin and the host command
 *          (`ARCHON_CLI_COMMAND`) the CLI and server publish.
 *
 * The source is never inferred from what happens to be installed. A selected
 * source that cannot answer fails the read; it never falls back to the other.
 * A container execution receives neither variable, so it reads through `gh`.
 */

import {
  preferredChecks,
  readChecks,
  type CheckUnit,
  type QualifiedPr,
} from './forge.ts';

export type CheckSource = 'gh' | 'forge';

/** Checks for one read. `revision` is null when the source does not report the evaluated head. */
export interface CheckRead {
  readonly source: CheckSource;
  readonly revision: string | null;
  readonly units: readonly CheckUnit[];
}

/**
 * The pack's gate policy over one read. A running check wins, so a gate never
 * concludes while anything is still running; red and unknown both block; gated
 * is reported as a maintainer's gate, never as green.
 */
export type GateState = 'none' | 'pending' | 'red' | 'gated' | 'green';

export function gateState(units: readonly CheckUnit[]): GateState {
  if (units.length === 0) return 'none';
  if (units.some(unit => unit.state === 'pending')) return 'pending';
  if (units.some(unit => unit.state === 'red' || unit.state === 'unknown')) return 'red';
  if (units.some(unit => unit.state === 'gated')) return 'gated';
  return 'green';
}

export function checkSource(value: string | undefined): CheckSource {
  const selected = (value ?? '').trim();
  if (selected === '' || selected === 'gh') return 'gh';
  if (selected === 'forge') return 'forge';
  throw new Error(`ARCHON_SDLC_CHECKS must be "gh" (the default) or "forge", not "${selected}"`);
}

interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

// Every gh call is captured: a node's stderr reaches the operator, and gh is
// chatty there (update notices), so only this pack's own messages may.
function gh(...args: string[]): Ran {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** gh's `[HOST/]OWNER/REPO` selector for the recorded pull request. */
function ghRepo(pr: QualifiedPr): string {
  return `${pr.repo.host}/${pr.repo.path}`;
}

interface GhCheck {
  readonly name: string;
  readonly bucket: string;
}

function isGhCheck(value: unknown): value is GhCheck {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.bucket === 'string';
}

/**
 * gh's buckets: `pass` and `skipping` are green, `pending` is running, `fail`
 * and `cancel` are red. A bucket this reader does not know is unknown, which
 * the gate treats as red: a cancelled or unrecognized check is not a green one.
 */
function ghUnit(check: GhCheck): CheckUnit {
  const unit = { name: check.name };
  switch (check.bucket) {
    case 'pending':
      return { unit, phase: 'pending', result: null, state: 'pending' };
    case 'pass':
    case 'skipping':
      return { unit, phase: 'completed', result: check.bucket, state: 'green' };
    case 'fail':
    case 'cancel':
      return { unit, phase: 'completed', result: check.bucket, state: 'red' };
    default:
      return { unit, phase: 'unknown', result: check.bucket, state: 'unknown' };
  }
}

function readGhChecks(pr: QualifiedPr): readonly CheckUnit[] {
  const number = String(pr.number);
  const result = gh('pr', 'checks', number, '--repo', ghRepo(pr), '--json', 'name,bucket');
  let parsed: unknown;
  try {
    // The document decides, not the exit status: this form reports failing checks
    // through the buckets it prints and exits non-zero on them.
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    // No document at all: either the pull request has no checks or the read
    // failed, and gh says which only in prose. The rollup count answers that as
    // a number. A failed observation is never evidence that no CI exists.
    const counted = gh(
      'pr',
      'view',
      number,
      '--repo',
      ghRepo(pr),
      '--json',
      'statusCheckRollup',
      '--jq',
      '.statusCheckRollup | length'
    );
    if (counted.ok && counted.stdout.trim() === '0') return [];
    throw new Error(`could not read check state: ${result.stderr.trim()}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isGhCheck)) {
    throw new Error(`unexpected check payload shape: ${result.stdout.slice(0, 200)}`);
  }
  return parsed.map(ghUnit);
}

/** Read the recorded pull request's checks from the selected source. */
export function readPrChecks(pr: QualifiedPr, selected: string | undefined): CheckRead {
  const source = checkSource(selected);
  if (source === 'gh') return { source, revision: null, units: readGhChecks(pr) };
  try {
    const observation = readChecks(pr);
    return {
      source,
      revision: observation.revision,
      units: preferredChecks(observation).units,
    };
  } catch (error) {
    throw new Error(
      `ARCHON_SDLC_CHECKS=forge: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Whether the repository has any active GitHub Actions workflow; undefined when
 * that could not be read, which counts as configured. Only the gh source asks
 * this: it lets a repository without CI skip the registration grace.
 */
export function hasActiveWorkflows(pr: QualifiedPr): boolean | undefined {
  // Every page: the default read stops at thirty workflows, and an active one on a
  // later page would otherwise read as "no CI configured".
  const result = gh(
    'api',
    '--hostname',
    pr.repo.host,
    `repos/${pr.repo.path}/actions/workflows`,
    '--paginate',
    '--slurp',
    '--jq',
    '[.[] | .workflows[] | select(.state == "active")] | length'
  );
  if (!result.ok) return undefined;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? undefined : count > 0;
}

/** `name (result)` for each unit, as the operator reads it. */
export function describeUnits(units: readonly CheckUnit[]): string {
  return units
    .map(unit => (unit.result === null ? unit.unit.name : `${unit.unit.name} (${unit.result})`))
    .join(', ');
}

/** ` at <revision>` when the source reported one. */
export function atRevision(read: CheckRead): string {
  return read.revision === null ? '' : ` at ${read.revision}`;
}
