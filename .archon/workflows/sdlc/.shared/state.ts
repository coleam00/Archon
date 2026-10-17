/**
 * The pack's state store and run reads, through the host's `archon` command.
 *
 * A queue's work item is a state document claimed with a conditional write
 * (`statePut` at the revision read). A claim is released only when the engine reports
 * the claiming run terminal, never on age.
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

export interface Stored {
  readonly revision: number;
  readonly value: unknown;
}

export function stateGet(name: string): Stored {
  const result = archon(['state', 'get', name]);
  const value = record(result.value);
  if (result.code !== 0 || typeof value?.revision !== 'number')
    throw failed(`state get ${name}`, result);
  return { revision: value.revision, value: value.value ?? null };
}

/** A conditional replace: `conflict` when the document moved past `ifRevision`. */
export function statePut(name: string, value: unknown, ifRevision: number): 'ok' | 'conflict' {
  const result = archon(
    ['state', 'put', name, '--if-revision', String(ifRevision)],
    JSON.stringify(value)
  );
  if (result.code === STATE_CONFLICT) return 'conflict';
  if (result.code !== 0) throw failed(`state put ${name}`, result);
  return 'ok';
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

export function stateList(prefix: string): string[] {
  const result = archon(['state', 'list', '--prefix', prefix]);
  const documents = record(result.value)?.documents;
  if (result.code !== 0 || !Array.isArray(documents)) throw failed('state list', result);
  return documents
    .map(record)
    .filter(row => row?.deleted === false && typeof row.name === 'string')
    .map(row => row?.name as string);
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
    return { name: row.name, revision: row.revision, value: row.value ?? null };
  });
}

/** One run as `archon workflow get --json` reports it, or undefined when it reports none. */
export function runDetail(runId: string): Record<string, unknown> | undefined {
  const result = archon(['workflow', 'get', runId, '--json']);
  return result.code === 0 ? record(result.value) : undefined;
}

/** The run's status as the engine reports it, or null when it gives no status. */
export function runStatus(runId: string): string | null {
  const status = runDetail(runId)?.status;
  return typeof status === 'string' ? status : null;
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

/** Whether a pickup may release a claim, from the claiming run's status. */
export function claimDisposition(status: string | null): 'hold' | 'release' {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
    ? 'release'
    : 'hold';
}
