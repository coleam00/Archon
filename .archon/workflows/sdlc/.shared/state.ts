/**
 * The pack's state store and run reads, through the host's `archon` command.
 *
 * A queue's work item is a state document claimed with a conditional write
 * (`statePut` at the revision read) that also takes the document's engine lease. A
 * claim is released only when the engine reports that lease ended, never on age.
 */

import { archonCommand, record } from './forge.ts';

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

