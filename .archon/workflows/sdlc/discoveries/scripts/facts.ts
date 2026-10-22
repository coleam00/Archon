/**
 * Build this pass's queue: the finished runs with records no pass decided yet, and the
 * base commit claims are checked against.
 *
 * A run's records become final when the run reaches a terminal status, so only
 * terminal runs are queued, oldest first. A record is settled once its run's
 * `discoveries/runs/<id>` document lists it as decided. Every run document is read in
 * one call. Each queued run is claimed with a conditional write on its document, so two
 * passes never decide the same run; a claim is released only when the claiming run is
 * terminal.
 *
 * Writes `$ARTIFACTS_DIR/drain/queue.json`: the queued records, each run with the
 * questions earlier passes asked about it, for the agent and the outcome.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseRunDocument,
  type QueuedRun,
  type RunDocument,
  RUNS_PREFIX,
  runName,
} from '../../.shared/discoveries.ts';
import { artifactsDir, emit, note, refuse, trimmed } from '../../.shared/io.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { fetchDefaultBranch } from '../../.shared/remote.ts';
import { latestVerdictOf, relayedDiscoveries } from '../../.shared/report.ts';
import {
  claimDisposition,
  listRuns,
  runStatus,
  stateDocuments,
  stateGet,
  statePut,
} from '../../.shared/state.ts';

/** The CLI lists at most this many runs, newest first. */
const LISTING = 1000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

function parseTime(name: string, value: string): number | undefined {
  if (value === '') return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`${name} must be an ISO-8601 time or empty, not "${value}"`);
  return at;
}

/** Every drained run's document, by run id, in one read. */
function readRunDocuments(): Map<string, RunDocument> {
  const documents = new Map<string, RunDocument>();
  for (const { name, value } of stateDocuments(RUNS_PREFIX)) {
    const document = parseRunDocument(name, value);
    if (document !== null) documents.set(name.slice(RUNS_PREFIX.length), document);
  }
  return documents;
}

/** The refs a pass already decided for a run; every ref when the run was drained before runs kept their own memory. */
function settledOf(document: RunDocument | undefined): ((ref: string) => boolean) {
  if (document === undefined) return () => false;
  if (document.decided === undefined) return () => document.claim === null;
  const decided = new Set(document.decided);
  return ref => decided.has(ref);
}

/**
 * Claim the run for this pass and return the document as claimed, or null when another pass
 * holds it or won the write. Callers decide from this document, not an earlier snapshot, so a
 * pass that settled the run in between is seen.
 */
function claimRun(runId: string, self: string, at: string): RunDocument | null {
  const name = runName(runId);
  const stored = stateGet(name);
  const current = parseRunDocument(name, stored.value);
  const held = current?.claim ?? null;
  if (held !== null && held.run_id !== self) {
    const status = runStatus(held.run_id);
    if (claimDisposition(status) === 'hold') {
      if (status === null) note(`${name} stays claimed: the engine reports no status for run ${held.run_id}`);
      return null;
    }
  }
  const claimed: RunDocument = { ...(current ?? { version: 1 }), claim: { run_id: self, at } };
  return statePut(name, claimed, stored.revision) === 'ok' ? claimed : null;
}

/** The run's undecided records and its questions, from the document this pass decides against. */
function undecided<R extends { ref: string }>(records: readonly R[], document: RunDocument | undefined): R[] {
  const settled = settledOf(document);
  return records.filter(record => !settled(record.ref));
}

/**
 * The run's undecided records and questions once this pass holds it, or null when nothing is
 * left to decide or another pass holds it. The snapshot only skips a claim that could not
 * matter; what is queued comes from the document as claimed.
 */
function claimUndecided<R extends { ref: string }>(
  id: string,
  all: readonly R[],
  pass: { self: string; at: string; snapshot: RunDocument | undefined }
): { records: R[]; questions: NonNullable<RunDocument['questions']> } | null {
  if (undecided(all, pass.snapshot).length === 0) return null;
  const document = claimRun(id, pass.self, pass.at);
  if (document === null) return null;
  const records = undecided(all, document);
  return records.length === 0 ? null : { records, questions: document.questions ?? [] };
}

function main(): void {
  // Every input is validated before anything is read or written.
  const since = parseTime('since', trimmed(process.env.INPUTS_SINCE));
  const until = parseTime('until', trimmed(process.env.INPUTS_UNTIL));
  const limit = Number(trimmed(process.env.INPUTS_LIMIT));
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const self = trimmed(process.env.WORKFLOW_ID);
  if (self === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  const base = fetchDefaultBranch(repo);
  const { sha } = base;
  const documents = readRunDocuments();
  const at = new Date().toISOString();

  const listed = listRuns(LISTING);
  if (listed.length >= LISTING) {
    note(`only the newest ${String(LISTING)} runs are listed; older runs are not drained in this pass`);
  }
  const candidates = listed
    .filter(run => typeof run.id === 'string' && run.id !== self)
    .filter(run => typeof run.status === 'string' && TERMINAL.includes(run.status))
    .map(run => ({
      run,
      completed: typeof run.completed_at === 'string' ? Date.parse(run.completed_at) : Number.NaN,
    }))
    .filter(({ completed }) => !Number.isNaN(completed))
    .filter(
      ({ completed }) =>
        (since === undefined || completed >= since) && (until === undefined || completed <= until)
    )
    .sort((left, right) => left.completed - right.completed);

  const queue: QueuedRun[] = [];
  for (const { run } of candidates) {
    if (queue.length >= limit) break;
    const id = run.id as string;
    if (typeof run.output_root !== 'string') continue;
    const artifacts = join(run.output_root, 'artifacts', 'runs', id);
    let relayed: ReturnType<typeof relayedDiscoveries>;
    try {
      relayed = relayedDiscoveries(artifacts, latestVerdictOf(artifacts));
    } catch (error) {
      note(`run ${id} is left queued: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (relayed.problems.length > 0) {
      note(`run ${id} is left queued: ${relayed.problems.join('; ')}`);
      continue;
    }
    const all = relayed.records.map(record => ({ ...record, ref: `${id}:${record.ref}` }));
    const claimed = claimUndecided(id, all, { self, at, snapshot: documents.get(id) });
    if (claimed === null) continue;
    queue.push({
      id,
      workflow: typeof run.workflow_name === 'string' ? run.workflow_name : '',
      completed_at: run.completed_at as string,
      artifacts,
      ...claimed,
    });
  }

  const drain = join(artifactsDir(), 'drain');
  mkdirSync(drain, { recursive: true });
  writeFileSync(
    join(drain, 'queue.json'),
    `${JSON.stringify({ base: { branch: base.branch, sha }, runs: queue }, null, 2)}\n`
  );
  emit({
    path: queue.length === 0 ? 'idle' : 'decide',
    base: { branch: base.branch, sha },
    policy_defaults: POLICY_DEFAULTS,
  });
}

try {
  main();
} catch (error) {
  refuse(`discoveries facts: ${error instanceof Error ? error.message : String(error)}`);
}
