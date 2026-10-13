/**
 * Standalone client for `archon forge`, the pack's opt-in forge source.
 *
 * One switch selects the source for every forge read and write this pack makes:
 *
 *   gh     the default. The GitHub CLI, as the pack has always used it.
 *   forge  opt-in with `ARCHON_SDLC_FORGE=forge`. An installed forge plugin,
 *          reached through the host command (`ARCHON_CLI_COMMAND`) the CLI and
 *          server publish.
 *
 * The source is never inferred from what happens to be installed, and a selected
 * source that cannot answer fails the operation rather than falling back to the
 * other. A container execution receives neither variable, so it uses `gh`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note } from './io.ts';

export type ForgeSource = 'gh' | 'forge';

// Read here, not in each calling script: the unbound-env checker scans a node-bound
// script's own text but never follows its imports, so a bare process.env read in a
// shared module like this one never trips a false "unbound variable" warning.
export function forgeSource(): ForgeSource {
  const selected = (process.env.ARCHON_SDLC_FORGE ?? '').trim();
  if (selected === '' || selected === 'gh') return 'gh';
  if (selected === 'forge') return 'forge';
  throw new Error(`ARCHON_SDLC_FORGE must be "gh" (the default) or "forge", not "${selected}"`);
}

export interface QualifiedPr {
  readonly repo: { readonly host: string; readonly path: string };
  readonly number: number;
}

/** The pull-request facts every later public action in a run depends on. */
export interface PrRecord extends QualifiedPr {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly is_draft: boolean;
  readonly state: 'open' | 'closed' | 'merged';
  readonly head_repo: { readonly host: string; readonly path: string } | null;
  readonly head_revision: string | null;
  readonly base_revision: string | null;
  readonly maintainer_can_modify: boolean | null;
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

export interface RerunGroup {
  readonly id: string;
  readonly attempt: number;
}
export interface ForgeCheckUnit extends CheckUnit {
  readonly unit: {
    readonly kind: 'check' | 'commit_status';
    readonly id: string;
    readonly name: string;
  };
  readonly rerun?: RerunGroup | null;
}
export interface ForgeCheckSet extends CheckSet {
  readonly units: readonly ForgeCheckUnit[];
}
export interface MergeRequest {
  readonly ref: QualifiedPr;
  readonly method: 'merge' | 'squash';
  readonly conditions: { readonly head?: string; readonly base?: string; readonly tree?: string };
}
export interface Landed {
  readonly commit: string | null;
  readonly tree: string | null;
  readonly parents: readonly string[] | null;
}
export interface MergeResult extends Omit<MergeRequest, 'ref'> {
  readonly target: QualifiedPr;
  readonly outcome: 'applied';
  readonly changed: true;
  readonly pr: PrRecord;
  readonly enforcedConditions: readonly (keyof MergeRequest['conditions'])[];
  readonly landed: Landed;
}
export interface SelectedCheck {
  readonly unit: ForgeCheckUnit['unit'];
  readonly rerun: RerunGroup | null;
}
export interface RerunRequest {
  readonly ref: QualifiedPr;
  readonly revision: string;
  readonly units: readonly SelectedCheck[];
}
export interface RerunResult extends RerunRequest {
  readonly target: QualifiedPr;
  readonly outcome: 'applied';
  readonly changed: true;
}
export interface ReviewItem {
  readonly kind: 'review' | 'review_comment';
  readonly id: string;
  readonly author: {
    readonly host: string;
    readonly id: string;
    readonly login: string | null;
  } | null;
  readonly commit: string | null;
  readonly state: string | null;
  readonly createdAt: string | null;
  readonly url: string;
  readonly body: string;
}
export interface ReviewsResult {
  readonly ref: QualifiedPr;
  readonly items: readonly ReviewItem[];
}
export interface MutationFailure {
  readonly op: string;
  readonly target: QualifiedPr | QualifiedPr['repo'];
  readonly outcome: 'refused' | 'verification_failed' | 'outcome_unknown';
  readonly leaveBehind?: string;
  readonly observed?: PrRecord;
  readonly merge?: {
    readonly method: MergeRequest['method'];
    readonly conditions: MergeRequest['conditions'];
    readonly landed?: Landed;
  };
  readonly rerun?: {
    readonly revision: string;
    readonly requested: readonly SelectedCheck[];
    readonly observed: readonly SelectedCheck[];
  };
}

export interface CheckSet {
  readonly units: readonly CheckUnit[];
  readonly summary: { readonly state: CheckState };
}

export interface ChecksObservation extends ForgeCheckSet {
  readonly approvalPending?: boolean | null;
  readonly ref: QualifiedPr;
  readonly revision: string;
  readonly required: ForgeCheckSet | null;
}

/**
 * Repository identity, compared the way a forge registers it.
 *
 * Host and owner/name are case-insensitive but case-preserving: a forge answers
 * with the case it has registered, whatever case this pack asked with. Comparing
 * exactly would read a pull request that is the requested one as a different one.
 */
export function sameRepo(left: QualifiedPr['repo'], right: QualifiedPr['repo']): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A forge operation that did not produce a verified result.
 *
 * `mutation` carries the evidence a write owes its caller: which of `refused`,
 * `verification_failed` or `outcome_unknown` happened, and what may remain on the
 * forge. A caller may report it; it may never retry past an unknown outcome.
 */
export class ForgeOperationError extends Error {
  constructor(
    message: string,
    readonly mutation: Record<string, unknown> | undefined
  ) {
    super(message);
    this.name = 'ForgeOperationError';
  }
}

/**
 * Run one typed forge operation.
 *
 * The request travels as a file so authored content — a pull-request body, a
 * review report — never appears in any process's argv.
 */
export function invokeForge(
  op: string,
  request: Record<string, unknown>
): Record<string, unknown> | null {
  const command = parseCommand(process.env.ARCHON_CLI_COMMAND);
  const directory = mkdtempSync(join(tmpdir(), 'archon-forge-'));
  const path = join(directory, 'request.json');
  try {
    writeFileSync(path, JSON.stringify(request), { mode: 0o600 });
    const result = Bun.spawnSync([...command, 'forge', op, '--json', '--data-file', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString());
    } catch {
      const detail = result.stderr.toString().trim();
      throw new Error(`forge ${op} failed${detail === '' ? '' : `: ${detail}`}`);
    }
    const response = record(parsed);
    if (!response || typeof response.operationId !== 'string' || response.operationId === '') {
      throw new Error(`forge ${op} returned an unexpected response envelope`);
    }
    // Exit 2 is the host saying it could not audit an operation that did complete.
    // The response on stdout is the real outcome, so the result is still a result;
    // losing it here would report a performed write as a failure.
    if (response.ok === true && result.exitCode === 2) {
      note(`forge ${op} completed but the host could not record it in the run's audit log.`);
    } else if (response.ok !== true || result.exitCode !== 0) {
      const mutation = record(response.mutation);
      const error = record(response.error);
      const outcome = typeof mutation?.outcome === 'string' ? mutation.outcome : undefined;
      const message = typeof error?.message === 'string' ? error.message : 'operation failed';
      throw new ForgeOperationError(
        `forge ${op} ${outcome ?? 'failed'}: ${message}${mutation ? ` ${JSON.stringify(mutation)}` : ''}`,
        mutation
      );
    }
    const body = record(response.result);
    if (body?.op !== op) throw new Error(`forge ${op} returned the wrong result`);
    // A read may answer "there is none": `pr.view` by head returns null when the
    // branch has no open pull request.
    if (body.value === null) return null;
    const value = record(body.value);
    if (!value) throw new Error(`forge ${op} returned the wrong result`);
    return value;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function qualifiedRepo(value: unknown): QualifiedPr['repo'] | undefined {
  const repo = record(value);
  return typeof repo?.host === 'string' &&
    repo.host.trim() !== '' &&
    typeof repo.path === 'string' &&
    repo.path.trim() !== ''
    ? { host: repo.host, path: repo.path }
    : undefined;
}

/** Validate only the pull-request facts this pack's policy consumes. */
export function parsePrRecord(value: unknown): PrRecord {
  const pr = record(value);
  const repo = qualifiedRepo(pr?.repo);
  const headRepo = pr?.head_repo === null ? null : qualifiedRepo(pr?.head_repo);
  const optionalText = (field: unknown): boolean =>
    field === null || (typeof field === 'string' && field !== '');
  if (
    pr?.schemaVersion !== 1 ||
    !repo ||
    typeof pr.number !== 'number' ||
    !Number.isInteger(pr.number) ||
    pr.number <= 0 ||
    typeof pr.url !== 'string' ||
    !URL.canParse(pr.url) ||
    typeof pr.head !== 'string' ||
    pr.head === '' ||
    typeof pr.base !== 'string' ||
    pr.base === '' ||
    typeof pr.is_draft !== 'boolean' ||
    (pr.state !== 'open' && pr.state !== 'closed' && pr.state !== 'merged') ||
    headRepo === undefined ||
    !optionalText(pr.head_revision) ||
    !optionalText(pr.base_revision) ||
    !(typeof pr.maintainer_can_modify === 'boolean' || pr.maintainer_can_modify === null)
  ) {
    throw new Error('forge returned an invalid pull-request record');
  }
  return {
    schemaVersion: 1,
    repo,
    number: pr.number,
    url: pr.url,
    head: pr.head,
    base: pr.base,
    is_draft: pr.is_draft,
    state: pr.state,
    head_repo: headRepo,
    head_revision: pr.head_revision as string | null,
    base_revision: pr.base_revision as string | null,
    maintainer_can_modify: pr.maintainer_can_modify,
  };
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

function parseUnit(value: unknown): ForgeCheckUnit | undefined {
  const item = record(value);
  const unit = record(item?.unit);
  const states: readonly CheckState[] = CHECK_STATES.filter(state => state !== 'none');
  const phases = ['pending', 'running', 'completed', 'unknown'] as const;
  if (
    (unit?.kind !== 'check' && unit?.kind !== 'commit_status') ||
    typeof unit.id !== 'string' ||
    unit.id === '' ||
    typeof unit?.name !== 'string' ||
    unit.name === '' ||
    !states.includes(item?.state as CheckState) ||
    !phases.includes(item?.phase as (typeof phases)[number]) ||
    !(typeof item?.result === 'string' || item?.result === null)
  )
    return undefined;
  let rerun: RerunGroup | null | undefined;
  if (item.rerun === null) rerun = null;
  else if (item.rerun !== undefined) {
    const group = record(item.rerun);
    if (
      !group ||
      typeof group.id !== 'string' ||
      group.id === '' ||
      typeof group.attempt !== 'number' ||
      !Number.isInteger(group.attempt) ||
      group.attempt <= 0
    )
      return undefined;
    rerun = { id: group.id, attempt: group.attempt };
  }
  return {
    unit: { kind: unit.kind, id: unit.id, name: unit.name },
    ...(rerun === undefined ? {} : { rerun }),
    phase: item.phase as CheckUnit['phase'],
    result: item.result,
    state: item.state as CheckUnit['state'],
  };
}

function parseSet(value: unknown): ForgeCheckSet | undefined {
  const set = record(value);
  const summary = record(set?.summary);
  const states: readonly CheckState[] = CHECK_STATES;
  if (!Array.isArray(set?.units) || !states.includes(summary?.state as CheckState))
    return undefined;
  const units = set.units.map(parseUnit);
  if (units.some(unit => unit === undefined)) return undefined;
  return { units: units as ForgeCheckUnit[], summary: { state: summary?.state as CheckState } };
}

function samePr(left: QualifiedPr, right: QualifiedPr): boolean {
  return left.number === right.number && sameRepo(left.repo, right.repo);
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
    !(
      value?.approvalPending === undefined ||
      value.approvalPending === null ||
      typeof value.approvalPending === 'boolean'
    ) ||
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
    approvalPending: value.approvalPending,
    units: full.units,
    summary: full.summary,
    required: required ?? null,
  };
}

export function preferredChecks(observation: ChecksObservation): CheckSet {
  return observation.required ?? observation;
}

export function parseCreatedWorkItem(value: unknown, repo: QualifiedPr['repo']): string {
  const result = record(value);
  const item = record(result?.workitem);
  const ref = parseQualifiedPr(JSON.stringify(item?.ref));
  if (
    result?.outcome !== 'applied' ||
    typeof result.changed !== 'boolean' ||
    item?.kind !== 'issue' ||
    !sameRepo(ref.repo, repo) ||
    typeof item.url !== 'string' ||
    !URL.canParse(item.url) ||
    (item.state !== 'open' && item.state !== 'closed')
  )
    throw new Error('forge returned an invalid created work item');
  return item.url;
}
export function readWorkItemLabels(ref: QualifiedPr): string[] {
  const value = invokeForge('workitem.view', { ref });
  const observed = parseQualifiedPr(JSON.stringify(value?.ref));
  if (!samePr(ref, observed) || value?.kind !== 'issue' || !Array.isArray(value.labels))
    throw new Error('forge work item has no verified issue identity and label facts');
  const labels: unknown[] = value.labels;
  return labels.map(name => {
    if (typeof name !== 'string' || name === '')
      throw new Error('forge returned an invalid issue label');
    return name;
  });
}
export function readRepositoryLabels(repo: QualifiedPr['repo']): string[] {
  const value = invokeForge('repo.labels.list', { repo });
  const observed = qualifiedRepo(value?.repo);
  if (!observed || !sameRepo(repo, observed) || !Array.isArray(value?.labels))
    throw new Error('forge returned invalid repository labels');
  return value.labels.map(row => {
    const label = record(row);
    if (typeof label?.name !== 'string' || label.name === '')
      throw new Error('forge returned invalid repository label');
    return label.name;
  });
}
