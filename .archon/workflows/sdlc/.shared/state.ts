/**
 * The pack's state store and run reads, through the host's `archon` command.
 *
 * A run claims a state document by taking its engine lease in a conditional write
 * (`statePut` at the revision read), and writes it afterwards only while it holds that
 * lease (`statePatchHeld`). The engine says who holds a document and whether that run
 * has ended; the pack keeps no record of its own and frees nothing on age.
 */

import { archonCommand, record } from './forge.ts';

const STATE_CONFLICT = 3;
const STATE_LEASE_LOST = 6;

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
 * A claim as documents recorded it before claims took an engine lease: the claiming
 * run's id in the document's own `claim` field. The pack still writes the key, always
 * null, because that earlier pack refuses a document without it.
 */
export interface LegacyClaim {
  readonly run_id: string;
}

/**
 * The run a pickup must leave the document to, or null when it is free to claim: the
 * run whose lease the engine reports live, else the run of a legacy claim no lease of
 * its own proves ended. Such a claim has no owner the engine can answer for, so only a
 * person clears it. A legacy claim whose run's lease ended is free.
 */
export function holder(stored: Pick<Stored, 'lease'>, legacy: LegacyClaim | null | undefined): string | null {
  if (stored.lease?.live === true) return stored.lease.runId;
  return legacy != null && stored.lease?.runId !== legacy.run_id ? legacy.run_id : null;
}

/** Whether a legacy claim is the run's own and no lease stands in for it, so the run's next write takes one. */
export function holdsLegacy(runId: string, stored: Pick<Stored, 'lease'>, legacy: LegacyClaim | null | undefined): boolean {
  return stored.lease === null && legacy?.run_id === runId;
}

/** Whether the run holds the document as read: by its lease, or by its own legacy claim. */
export function holds<Doc extends { readonly claim: LegacyClaim | null }>(
  runId: string,
  stored: Pick<Stored, 'lease'>,
  doc: Doc | null
): doc is Doc {
  return doc !== null && (stored.lease?.runId === runId || holdsLegacy(runId, stored, doc.claim));
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

export type StatePatchOp =
  | { readonly op: 'set'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'append'; readonly path: string; readonly value: unknown };

/** Apply ops to the latest revision; a patch never conflicts. */
export function statePatch(name: string, ops: readonly StatePatchOp[]): void {
  const result = archon(['state', 'patch', name], JSON.stringify({ ops }));
  if (result.code !== 0) throw failed(`state patch ${name}`, result);
}

/** One `set` or `remove` per top-level field in which `after` differs from `before`. */
function fieldOps(before: object, after: object): StatePatchOp[] {
  const [was, now]: Record<string, unknown>[] = [{ ...before }, { ...after }];
  const ops: StatePatchOp[] = [];
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const value = now[key];
    if (value === undefined) {
      if (was[key] !== undefined) ops.push({ op: 'remove', path: `/${key}` });
    } else if (JSON.stringify(was[key]) !== JSON.stringify(value)) {
      ops.push({ op: 'set', path: `/${key}`, value });
    }
  }
  // A write that changes no field still proves the hold, or gives the lease back.
  const [unchanged] = Object.entries(now);
  return ops.length === 0 && unchanged !== undefined ? [{ op: 'set', path: `/${unchanged[0]}`, value: unchanged[1] }] : ops;
}

/**
 * Write `after` over `before`, the value read, on a document the run holds, and return
 * the value written. Only the top-level fields that differ are set, on the latest
 * revision, so what another writer appended to any other field since the read survives.
 * `held` makes the write only while the run's lease is live; `take` is for a legacy
 * claim, which has no lease until this write takes one. `release` gives the lease back
 * in the same write. Throws when the run no longer holds the document.
 */
export function stateWriteHeld(
  name: string,
  before: object,
  after: object,
  lease: { readonly by: 'held' | 'take'; readonly release: boolean }
): unknown {
  const release = lease.release ? ['--release-lease'] : [];
  const flags = lease.by === 'held' ? ['--held', ...release] : lease.release ? release : ['--lease'];
  const result = archon(['state', 'patch', name, ...flags], JSON.stringify({ ops: fieldOps(before, after) }));
  // Without --if-revision, exit 3 is another run's live lease.
  if (result.code === STATE_LEASE_LOST || result.code === STATE_CONFLICT) {
    throw new Error(`${name} is no longer claimed by this run`);
  }
  const value = record(result.value)?.value;
  if (result.code !== 0 || value === undefined) throw failed(`state patch ${name}`, result);
  return value;
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

