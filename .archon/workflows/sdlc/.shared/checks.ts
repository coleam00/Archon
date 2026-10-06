/**
 * The deliver pack's one pull-request check reader and its gate policy.
 *
 * Both sources return the same units, so `check-ci` and `confirm-ready`
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

/**
 * A check as one read observed it. `completedAt` (epoch milliseconds) is when it
 * concluded, null while it runs or when the source does not report it: the forge
 * contract carries no check times, so only the gh source has them.
 */
export interface ReadUnit extends CheckUnit {
  readonly completedAt: number | null;
}

/** Checks for one read. `revision` is null when the source does not report the evaluated head. */
export interface CheckRead {
  readonly approvalPending?: boolean | null;
  readonly source: ForgeSource;
  readonly revision: string | null;
  readonly units: readonly ReadUnit[];
}

/**
 * How long after the ready flip a skip is not yet the CI's answer. A project whose
 * CI skips drafts registers its ready runs within seconds of the flip; one whose CI
 * does not run again on the flip never will. Past this window a skip counts as
 * green again, so the second shape costs one wait cycle, never the whole wait.
 */
export const READY_RUN_GRACE_MS = 120_000;

/** Whether `now` is within the grace window of this run's flip. */
function awaitingReadyRuns(flippedAt: number | null, now: number): boolean {
  return flippedAt !== null && now - flippedAt < READY_RUN_GRACE_MS;
}

/**
 * Checks skipped before the pull request was marked ready, while the ready runs
 * that replace them may still register. A project whose CI skips drafts reports its
 * draft-time jobs as skipped; they say nothing about the ready pull request.
 * `flippedAt` is null when this run did not flip the pull request, and then
 * nothing is stale.
 */
export function draftSkips(
  units: readonly ReadUnit[],
  flippedAt: number | null,
  now: number = Date.now()
): ReadUnit[] {
  if (flippedAt === null || !awaitingReadyRuns(flippedAt, now)) return [];
  return units.filter(
    unit => unit.result === 'skipped' && unit.completedAt !== null && unit.completedAt < flippedAt
  );
}

/**
 * The pack's gate policy over one read. A running check wins, so a gate never
 * concludes while anything is still running; red and unknown both block; gated is
 * reported as a maintainer's gate, never as green. Within the grace window after
 * this run's flip, a check skipped before the flip counts as not yet run, and so
 * does a set in which every check was skipped (the forge source reports no check
 * times, so this is how it sees a draft's skips): the ready runs that replace them
 * may still register.
 */
export type GateState = 'none' | 'pending' | 'red' | 'gated' | 'green';

export function gateState(
  units: readonly ReadUnit[],
  flippedAt: number | null,
  now: number = Date.now()
): GateState {
  if (units.length === 0) return 'none';
  if (units.some(unit => unit.state === 'pending')) return 'pending';
  if (draftSkips(units, flippedAt, now).length > 0) return 'pending';
  if (units.some(unit => unit.state === 'red' || unit.state === 'unknown')) return 'red';
  if (units.some(unit => unit.state === 'gated')) return 'gated';
  if (awaitingReadyRuns(flippedAt, now) && units.every(unit => unit.result === 'skipped')) {
    return 'pending';
  }
  return 'green';
}

/**
 * The flip time a binding carries: `flip-ready`'s ISO timestamp, or empty/`null`
 * when this run did not flip the pull request.
 */
export function parseFlippedAt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') return null;
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) throw new Error(`the flip time is not a timestamp: ${trimmed}`);
  return time;
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

/** One row of `gh pr checks --json name,state,completedAt`. */
export interface GhCheck {
  readonly name: string;
  readonly state: string;
  readonly completedAt?: string;
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

/** gh's completion time, or null: a running check reports the zero time. */
function ghCompletedAt(check: GhCheck): number | null {
  const time = check.completedAt === undefined ? Number.NaN : Date.parse(check.completedAt);
  return Number.isNaN(time) || time <= 0 ? null : time;
}

function readGhChecks(pr: QualifiedPr): readonly ReadUnit[] {
  const number = String(pr.number);
  const result = gh('pr', 'checks', number, '--repo', ghRepo(pr), '--json', 'name,state,completedAt');
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
  return parsed.map(check => ({ ...ghCheckUnit(check), completedAt: ghCompletedAt(check) }));
}

/** Read the recorded pull request's checks from the selected source. */
export function readPrChecks(pr: QualifiedPr): CheckRead {
  const source = forgeSource();
  if (source === 'gh') return { source, revision: null, units: readGhChecks(pr) };
  try {
    const observation = readChecks(pr);
    return {
      source,
      revision: observation.revision,
      approvalPending: observation.approvalPending,
      units: preferredChecks(observation).units.map(unit => ({ ...unit, completedAt: null })),
    };
  } catch (error) {
    throw new Error(
      `ARCHON_SDLC_FORGE=forge: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** The expected checks that have not registered on the pull request, by exact name. */
export function missingChecks(units: readonly CheckUnit[], expected: readonly string[]): string[] {
  const present = new Set(units.map(unit => unit.unit.name));
  return expected.filter(name => !present.has(name));
}

/**
 * Whether the forge reports CI on the pull request's head waiting for a maintainer's
 * approval: a workflow run for that commit concluded `action_required`. GitHub
 * starts no check for such a run, so silence alone never says this; the run's own
 * conclusion does. The forge source reports that fact with its observation; the gh
 * source reads the head's workflow runs. A failed read refuses rather than guessing.
 */
export function approvalPending(pr: QualifiedPr, read: CheckRead): boolean {
  if (read.source !== 'gh') return read.approvalPending === true;
  const head = gh('pr', 'view', String(pr.number), '--repo', ghRepo(pr), '--json', 'headRefOid', '--jq', '.headRefOid');
  if (!head.ok || head.stdout.trim() === '') {
    throw new Error(`could not read the pull request's head commit: ${head.stderr.trim()}`);
  }
  const runs = gh(
    'api',
    '--hostname',
    pr.repo.host,
    `repos/${pr.repo.path}/actions/runs?head_sha=${head.stdout.trim()}`,
    '--jq',
    '[.workflow_runs[] | select(.conclusion == "action_required")] | length'
  );
  if (!runs.ok) throw new Error(`could not read workflow runs for the head commit: ${runs.stderr.trim()}`);
  return Number.parseInt(runs.stdout.trim(), 10) > 0;
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
