/** Standalone client for `archon forge checks`, the opt-in check source in ./checks.ts. */

export interface QualifiedPr {
  readonly repo: { readonly host: string; readonly path: string };
  readonly number: number;
}

// This standalone boundary is checked against @archon/forge by forge-contract.test.ts.
export const CHECK_STATES = ['none', 'pending', 'green', 'red', 'gated', 'unknown'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/**
 * How a concluded check's result gates: @archon/forge's `concludedCheckStates`,
 * which the forge plugins classify through. The gh reader in ./checks.ts uses
 * this copy so both sources classify a GitHub conclusion the same way.
 */
export const CONCLUDED_CHECK_STATES = {
  success: 'green',
  neutral: 'green',
  skipped: 'green',
  action_required: 'gated',
  failure: 'red',
  cancelled: 'red',
  timed_out: 'red',
  stale: 'red',
  startup_failure: 'red',
  unknown: 'unknown',
} as const satisfies Record<string, Exclude<CheckState, 'none' | 'pending'>>;

export interface CheckUnit {
  readonly unit: { readonly name: string };
  readonly phase: 'pending' | 'running' | 'completed' | 'unknown';
  readonly result: string | null;
  readonly state: Exclude<CheckState, 'none'>;
}

export interface CheckSet {
  readonly units: readonly CheckUnit[];
  readonly summary: { readonly state: CheckState };
}

export interface ChecksObservation extends CheckSet {
  readonly ref: QualifiedPr;
  readonly revision: string;
  readonly required: CheckSet | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseQualifiedPr(value: string | undefined): QualifiedPr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new Error('the bound pull request is not valid JSON');
  }
  const pr = record(parsed);
  const repo = record(pr?.repo);
  if (
    typeof repo?.host !== 'string' ||
    repo.host.trim() === '' ||
    typeof repo.path !== 'string' ||
    repo.path.trim() === '' ||
    typeof pr?.number !== 'number' ||
    !Number.isInteger(pr.number) ||
    pr.number <= 0
  ) {
    throw new Error('the bound pull request has no qualified repo and positive number');
  }
  return { repo: { host: repo.host, path: repo.path }, number: pr.number };
}

function parseCommand(value: string | undefined): readonly string[] {
  if (value === undefined || value === '') {
    throw new Error(
      'ARCHON_CLI_COMMAND is not set; the host that started this run did not publish its CLI command'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new Error('ARCHON_CLI_COMMAND is not a JSON string array');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(part => typeof part === 'string' && part !== '')
  ) {
    throw new Error('ARCHON_CLI_COMMAND must be a non-empty JSON string array');
  }
  return parsed as string[];
}

function parseUnit(value: unknown): CheckUnit | undefined {
  const item = record(value);
  const unit = record(item?.unit);
  const states: readonly CheckState[] = CHECK_STATES.filter(state => state !== 'none');
  const phases = ['pending', 'running', 'completed', 'unknown'] as const;
  if (
    typeof unit?.name !== 'string' ||
    unit.name === '' ||
    !states.includes(item?.state as CheckState) ||
    !phases.includes(item?.phase as (typeof phases)[number]) ||
    !(typeof item?.result === 'string' || item?.result === null)
  )
    return undefined;
  return {
    unit: { name: unit.name },
    phase: item.phase as CheckUnit['phase'],
    result: item.result,
    state: item.state as CheckUnit['state'],
  };
}

function parseSet(value: unknown): CheckSet | undefined {
  const set = record(value);
  const summary = record(set?.summary);
  const states: readonly CheckState[] = CHECK_STATES;
  if (!Array.isArray(set?.units) || !states.includes(summary?.state as CheckState))
    return undefined;
  const units = set.units.map(parseUnit);
  if (units.some(unit => unit === undefined)) return undefined;
  return { units: units as CheckUnit[], summary: { state: summary?.state as CheckState } };
}

function samePr(left: QualifiedPr, right: QualifiedPr): boolean {
  return (
    left.number === right.number &&
    left.repo.host === right.repo.host &&
    left.repo.path === right.repo.path
  );
}

/** Invoke `archon forge checks` and validate only the fields pack policy consumes. */
export function readChecks(ref: QualifiedPr): ChecksObservation {
  const command = parseCommand(process.env.ARCHON_CLI_COMMAND);
  const result = Bun.spawnSync(
    [...command, 'forge', 'checks', '--json', '--data', JSON.stringify({ ref })],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString());
  } catch {
    if (result.exitCode !== 0)
      throw new Error(`forge check read failed: ${result.stderr.toString().trim()}`);
    throw new Error('forge check read returned invalid JSON');
  }
  const response = record(parsed);
  if (response?.ok === false) {
    const error = record(response.error);
    throw new Error(
      `forge check read failed: ${typeof error?.message === 'string' ? error.message : 'unknown error'}`
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`forge check read failed${detail === '' ? '' : `: ${detail}`}`);
  }
  const resultBody = record(response?.result);
  const value = record(resultBody?.value);
  const observedRef = record(value?.ref);
  const observedRepo = record(observedRef?.repo);
  const observed =
    observedRepo && typeof observedRef?.number === 'number'
      ? { repo: { host: observedRepo.host, path: observedRepo.path }, number: observedRef.number }
      : undefined;
  const full = parseSet(value);
  const required = value?.required === null ? null : parseSet(value?.required);
  if (
    typeof response?.operationId !== 'string' ||
    response.operationId === '' ||
    response.ok !== true ||
    resultBody?.op !== 'checks.state' ||
    typeof value?.revision !== 'string' ||
    value.revision === '' ||
    !observed ||
    typeof observed.repo.host !== 'string' ||
    typeof observed.repo.path !== 'string' ||
    !samePr(ref, observed as QualifiedPr) ||
    !full ||
    (value?.required !== null && !required)
  ) {
    throw new Error('forge check read returned an unexpected response shape or target');
  }
  return {
    ref,
    revision: value.revision,
    units: full.units,
    summary: full.summary,
    required: required ?? null,
  };
}

export function preferredChecks(observation: ChecksObservation): CheckSet {
  return observation.required ?? observation;
}
