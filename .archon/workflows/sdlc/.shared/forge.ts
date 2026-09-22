/** Standalone client for forge CLI operations used by bundled workflow scripts. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface QualifiedPr {
  readonly repo: { readonly host: string; readonly path: string };
  readonly number: number;
}

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

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ForgeOperationError extends Error {
  constructor(
    message: string,
    readonly response: Record<string, unknown>,
    readonly mutation: Record<string, unknown> | undefined
  ) {
    super(message);
    this.name = 'ForgeOperationError';
  }
}

function forgeCommand(): readonly string[] {
  return parseCommand(process.env.ARCHON_CLI_COMMAND);
}

function safeAppliedEvidence(
  operationId: string,
  result: Record<string, unknown> | undefined
): Record<string, unknown> {
  const value = record(result?.value);
  const pr = record(value?.pr);
  const comment = record(value?.comment);
  return {
    operationId,
    op: result?.op,
    outcome: value?.outcome,
    target: value?.target,
    requested: value?.requested,
    enforced: value?.enforced,
    changed: value?.changed,
    ...(pr
      ? { pr: { repo: pr.repo, number: pr.number, url: pr.url } }
      : {}),
    ...(comment
      ? { comment: { ref: comment.ref, id: comment.id, url: comment.url } }
      : {}),
  };
}

/** Run one typed forge operation without placing authored bodies in argv. */
export function invokeForge(op: string, request: Record<string, unknown>): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'archon-forge-'));
  const path = join(directory, 'request.json');
  try {
    writeFileSync(path, JSON.stringify(request), { mode: 0o600 });
    const result = Bun.spawnSync([...forgeCommand(), 'forge', op, '--json', '--data-file', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString());
    } catch {
      throw new Error(
        `forge ${op} returned invalid JSON${result.stderr.length ? `: ${result.stderr.toString().trim()}` : ''}`
      );
    }
    const response = record(parsed);
    if (!response || typeof response.operationId !== 'string') {
      throw new Error(`forge ${op} returned an unexpected response envelope`);
    }
    const resultBody = record(response.result);
    if (response.ok === true && result.exitCode === 2) {
      const applied = safeAppliedEvidence(response.operationId, resultBody);
      throw new ForgeOperationError(
        `forge ${op} applied/read succeeded; audit persistence failed: ${JSON.stringify(applied)}`,
        response,
        record(resultBody?.value)
      );
    }
    if (response.ok !== true || result.exitCode !== 0) {
      const mutation = record(response.mutation);
      const error = record(response.error);
      const outcome = typeof mutation?.outcome === 'string' ? mutation.outcome : undefined;
      const message = typeof error?.message === 'string' ? error.message : 'operation failed';
      const evidence = mutation ? ` ${JSON.stringify(mutation)}` : '';
      throw new ForgeOperationError(
        `forge ${op} ${outcome ?? 'failed'}: ${message}${evidence}`,
        response,
        mutation
      );
    }
    const value = record(resultBody?.value);
    if (resultBody?.op !== op || !value) throw new Error(`forge ${op} returned the wrong result`);
    return value;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function repo(value: unknown): QualifiedPr['repo'] | undefined {
  const candidate = record(value);
  return typeof candidate?.host === 'string' && candidate.host !== '' &&
    typeof candidate.path === 'string' && candidate.path !== ''
    ? { host: candidate.host, path: candidate.path }
    : undefined;
}

export function parsePrRecord(value: unknown): PrRecord {
  const pr = record(value);
  const identity = repo(pr?.repo);
  const headRepo = pr?.head_repo === null ? null : repo(pr?.head_repo);
  if (
    pr?.schemaVersion !== 1 || !identity ||
    typeof pr.number !== 'number' || !Number.isInteger(pr.number) || pr.number <= 0 ||
    typeof pr.url !== 'string' || !URL.canParse(pr.url) || typeof pr.head !== 'string' || pr.head === '' ||
    typeof pr.base !== 'string' || pr.base === '' || typeof pr.is_draft !== 'boolean' ||
    !['open', 'closed', 'merged'].includes(String(pr.state)) ||
    (pr.head_repo !== null && !headRepo) ||
    !(typeof pr.head_revision === 'string' && pr.head_revision !== '' || pr.head_revision === null) ||
    !(typeof pr.base_revision === 'string' && pr.base_revision !== '' || pr.base_revision === null) ||
    !(typeof pr.maintainer_can_modify === 'boolean' || pr.maintainer_can_modify === null)
  ) throw new Error('forge returned an invalid pull-request record');
  const verifiedHeadRepo = pr.head_repo === null ? null : headRepo;
  if (verifiedHeadRepo === undefined) throw new Error('forge returned an invalid head repository');
  const state = pr.state === 'open' ? 'open' : pr.state === 'closed' ? 'closed' : 'merged';
  return {
    schemaVersion: 1, repo: identity, number: pr.number, url: pr.url, head: pr.head,
    base: pr.base, is_draft: pr.is_draft, state,
    head_repo: verifiedHeadRepo, head_revision: pr.head_revision,
    base_revision: pr.base_revision,
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
export function readChecks(boundPr: string | undefined): ChecksObservation {
  const ref = parseQualifiedPr(boundPr);
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
