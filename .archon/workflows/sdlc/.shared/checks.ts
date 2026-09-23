/**
 * The deliver pack's one pull-request check reader and its gate policy.
 *
 * Both sources return the same units, so `check-ci`, `ci-note` and `flip-ready`
 * classify one shape whichever source read it. ./forge.ts owns which source a
 * run selected; this file owns how a read is performed and how it gates.
 */

import {
  CONCLUDED_CHECK_STATES,
  forgeSource,
  preferredChecks,
  readChecks,
  type CheckUnit,
  type ForgeSource,
  type QualifiedPr,
} from './forge.ts';

/** Checks for one read. `revision` is null when the source does not report the evaluated head. */
export interface CheckRead {
  readonly source: ForgeSource;
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

/** One row of `gh pr checks --json name,state`. */
export interface GhCheck {
  readonly name: string;
  readonly state: string;
}

function isGhCheck(value: unknown): value is GhCheck {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.state === 'string';
}

// gh's `state` before a check concludes: a check run's status, or a commit
// status's PENDING or EXPECTED.
const GH_RUNNING: readonly string[] = [
  'EXPECTED',
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
];

/**
 * Classify one gh row. Once a check concludes, gh's `state` is the check run's
 * conclusion or the commit status's state, classified through the forge table
 * so gh and forge agree. gh's `bucket` is not used: it calls ACTION_REQUIRED a
 * failure, and STALE, STARTUP_FAILURE and any state it does not know pending.
 * A state this reader does not know is unknown, which the gate treats as red.
 */
export function ghCheckUnit(check: GhCheck): CheckUnit {
  const unit = { name: check.name };
  if (GH_RUNNING.includes(check.state)) {
    return { unit, phase: 'pending', result: null, state: 'pending' };
  }
  const result = check.state.toLowerCase();
  // A commit status's ERROR is its failure, as the forge plugin reads it.
  const key = result === 'error' ? 'failure' : result;
  const state = Object.hasOwn(CONCLUDED_CHECK_STATES, key)
    ? CONCLUDED_CHECK_STATES[key as keyof typeof CONCLUDED_CHECK_STATES]
    : 'unknown';
  return { unit, phase: state === 'unknown' ? 'unknown' : 'completed', result, state };
}

function readGhChecks(pr: QualifiedPr): readonly CheckUnit[] {
  const number = String(pr.number);
  const result = gh('pr', 'checks', number, '--repo', ghRepo(pr), '--json', 'name,state');
  let parsed: unknown;
  try {
    // The document decides, not the exit status: gh prints it and exits non-zero
    // when any check is failing or pending.
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
  return parsed.map(ghCheckUnit);
}

/** Read the recorded pull request's checks from the selected source. */
export function readPrChecks(pr: QualifiedPr, selected: string | undefined): CheckRead {
  const source = forgeSource(selected);
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
      `ARCHON_SDLC_FORGE=forge: ${error instanceof Error ? error.message : String(error)}`
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
  // later page would otherwise read as "no CI configured". gh applies --jq to each
  // page and refuses --slurp with --jq, so the filter prints one id per active
  // workflow and the lines are counted here.
  const result = gh(
    'api',
    '--hostname',
    pr.repo.host,
    `repos/${pr.repo.path}/actions/workflows`,
    '--paginate',
    '--jq',
    '.workflows[] | select(.state == "active") | .id'
  );
  if (!result.ok) return undefined;
  return result.stdout.split('\n').some(line => line.trim() !== '');
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
