/**
 * The pack's state store and run reads, through the host's `archon` command.
 *
 * A queue run owns a work item while it holds the document's engine lease, which
 * `stateClaim` takes; every write the run then makes is `statePutHeld`, which the store
 * refuses once the lease is no longer the run's. The engine alone says whether a lease
 * is live.
 */

import { archonCommand, record } from './forge.ts';

const NONE_CLAIMED = 2;
const STATE_CONFLICT = 3;

function archon(args: readonly string[], input?: string): { code: number; value: unknown } {
  const result = Bun.spawnSync([...archonCommand(), ...args], {
    // Bun spawns with the environment as the process started unless given the live one.
    env: process.env,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString());
  } catch {
    value = undefined;
  }
  return { code: result.exitCode, value };
}

function failed(what: string, result: { code: number; value: unknown }): Error {
  const message = record(result.value)?.error;
  return new Error(
    `archon ${what} failed (exit ${String(result.code)})${typeof message === 'string' ? `: ${message}` : ''}`
  );
}

/** The engine's lease on a document: which run holds it, and whether that run still owns it. */
export interface Lease {
  readonly runId: string;
  readonly live: boolean;
}

export interface Stored {
  readonly revision: number;
  readonly value: unknown;
  readonly lease: Lease | null;
}

/** The lease `archon state` reports, as the pack reads it; anything else reads as no lease. */
export function parseLease(value: unknown): Lease | null {
  const row = record(value);
  return typeof row?.runId === 'string' && typeof row.live === 'boolean'
    ? { runId: row.runId, live: row.live }
    : null;
}

export function stateGet(name: string): Stored {
  const result = archon(['state', 'get', name]);
  const value = record(result.value);
  if (result.code !== 0 || typeof value?.revision !== 'number')
    throw failed(`state get ${name}`, result);
  return { revision: value.revision, value: value.value ?? null, lease: parseLease(value.lease) };
}

/**
 * Whether the run holding a claim has ended without clearing it, as its lease reports.
 * A claim with no lease of its run, written before claims took one, is never proven ended.
 */
export function claimEnded(claimRunId: string, stored: Pick<Stored, 'lease'>): boolean {
  return stored.lease?.runId === claimRunId && !stored.lease.live;
}

/**
 * A conditional replace: `conflict` when the document moved past `ifRevision`, or when
 * `lease` is given and another run's lease is live. `take` claims the document's lease
 * for this run; `release` gives it back.
 */
export function statePut(
  name: string,
  value: unknown,
  ifRevision: number,
  lease?: 'take' | 'release'
): 'ok' | 'conflict' {
  const flag = lease === 'take' ? ['--lease'] : lease === 'release' ? ['--release-lease'] : [];
  const result = archon(
    ['state', 'put', name, '--if-revision', String(ifRevision), ...flag],
    JSON.stringify(value)
  );
  if (result.code === STATE_CONFLICT) return 'conflict';
  if (result.code !== 0) throw failed(`state put ${name}`, result);
  return 'ok';
}

/** A conditional replace of a claimed document; clearing its claim gives its lease back in the same write. */
export function statePutClaimed(
  name: string,
  value: { readonly claim: unknown },
  ifRevision: number
): 'ok' | 'conflict' {
  return statePut(name, value, ifRevision, value.claim === null ? 'release' : undefined);
}

/**
 * A conditional replace the store makes only while this run holds the document's live
 * lease; `release` gives the lease back in the same write.
 */
export function statePutHeld(
  name: string,
  value: unknown,
  ifRevision: number,
  release: boolean
): 'ok' | 'revision_moved' | 'lease_not_held' {
  const result = archon(
    ['state', 'put', name, '--if-revision', String(ifRevision), '--held', ...(release ? ['--release-lease'] : [])],
    JSON.stringify(value)
  );
  if (result.code === 0) return 'ok';
  const reason = record(result.value)?.reason;
  if (result.code === STATE_CONFLICT && (reason === 'revision_moved' || reason === 'lease_not_held')) return reason;
  throw failed(`state put ${name}`, result);
}

export interface ClaimCandidate {
  readonly name: string;
  readonly ifRevision: number;
}

/** Why the engine passed a candidate over; `holder` is the run whose live lease held it. */
export interface ClaimSkip {
  readonly name: string;
  readonly reason: string;
  readonly holder: string | null;
}

export interface Claimed {
  readonly claimed: (Stored & { readonly name: string }) | null;
  readonly skipped: readonly ClaimSkip[];
}

/** What `archon state claim` printed, as the pack reads it; undefined when it is not a claim result. */
export function parseClaimed(output: unknown): Claimed | undefined {
  const value = record(output);
  if (!Array.isArray(value?.skipped)) return undefined;
  const skipped: ClaimSkip[] = [];
  for (const entry of value.skipped) {
    const skip = record(entry);
    if (typeof skip?.name !== 'string' || typeof skip.reason !== 'string') return undefined;
    const holder = record(skip.holder)?.runId;
    skipped.push({ name: skip.name, reason: skip.reason, holder: typeof holder === 'string' ? holder : null });
  }
  if (value.claimed === null) return { claimed: null, skipped };
  const claimed = record(value.claimed);
  if (typeof claimed?.name !== 'string' || typeof claimed.revision !== 'number') return undefined;
  return {
    claimed: { name: claimed.name, revision: claimed.revision, value: claimed.value ?? null, lease: parseLease(claimed.lease) },
    skipped,
  };
}

/**
 * Take the lease of the first candidate, in the order given, that is still at its
 * revision and that no other live run holds. `claimed` is null when none could be taken.
 */
export function stateClaim(candidates: readonly ClaimCandidate[]): Claimed {
  const result = archon(['state', 'claim'], JSON.stringify(candidates));
  const claimed = result.code === 0 || result.code === NONE_CLAIMED ? parseClaimed(result.value) : undefined;
  if (claimed === undefined) throw failed('state claim', result);
  return claimed;
}

export type StatePatchOp =
  | { readonly op: 'set'; readonly path: string; readonly value: unknown }
  | { readonly op: 'append'; readonly path: string; readonly value: unknown };

/** Apply ops to the latest revision; a patch never conflicts. */
export function statePatch(name: string, ops: readonly StatePatchOp[]): void {
  const result = archon(['state', 'patch', name], JSON.stringify({ ops }));
  if (result.code !== 0) throw failed(`state patch ${name}`, result);
}

/** Append to an array in the latest revision; appends never conflict. */
export function stateAppend(name: string, path: string, value: unknown): void {
  statePatch(name, [{ op: 'append', path, value }]);
}

/** Every live document under the prefix with its value, in one read. */
export function stateDocuments(prefix: string): (Stored & { readonly name: string })[] {
  const result = archon(['state', 'list', '--prefix', prefix, '--values']);
  const documents = record(result.value)?.documents;
  if (result.code !== 0 || !Array.isArray(documents)) throw failed('state list', result);
  return documents.map(entry => {
    const row = record(entry);
    if (typeof row?.name !== 'string' || typeof row.revision !== 'number')
      throw failed('state list', result);
    return {
      name: row.name,
      revision: row.revision,
      value: row.value ?? null,
      lease: parseLease(row.lease),
    };
  });
}

/** The Archon user a run was started as or for, as `archon workflow get` reports it; null when it records none. */
export function runUser(runId: string): string | null {
  const result = archon(['workflow', 'get', runId, '--json']);
  const value = record(result.value);
  if (result.code !== 0 || value === undefined) throw failed(`workflow get ${runId}`, result);
  return typeof value.user_id === 'string' && value.user_id !== '' ? value.user_id : null;
}

/**
 * This project's runs, newest first, as `archon workflow runs --json` lists them.
 * Refuses a listing that fell back to every project's runs: draining another
 * project's runs into this repository would be a wrong write, not a wider read.
 */
export function listRuns(limit: number): Record<string, unknown>[] {
  const result = archon(['workflow', 'runs', '--json', '--limit', String(limit)]);
  const value = record(result.value);
  if (result.code !== 0 || !Array.isArray(value?.runs)) throw failed('workflow runs', result);
  if (value.scopeFallback === true) {
    throw new Error('archon workflow runs could not scope the listing to this project');
  }
  return value.runs.map(record).filter((row): row is Record<string, unknown> => row !== undefined);
}

