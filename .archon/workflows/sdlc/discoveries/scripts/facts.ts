/**
 * Build this pass's queue: the finished runs with records no decision settled yet,
 * every decision made so far, and the base commit claims are checked against.
 *
 * A run's records become final when the run reaches a terminal status, so only
 * terminal runs are queued, oldest first. A record is settled once a decision record
 * that is not `asked` lists it. Each queued run is claimed with a conditional write
 * on its `discoveries/runs/<id>` document, so two passes never decide the same run;
 * a claim is released only when the claiming run is terminal.
 *
 * Writes `$ARTIFACTS_DIR/drain/queue.json` (the queued records, for the agent and the
 * outcome) and `$ARTIFACTS_DIR/drain/discovery-decisions.md` (every stored decision).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DECISIONS_PREFIX,
  type DecisionRecord,
  decidedRefs,
  parseDecisionRecord,
  parseRunClaim,
  type QueuedRun,
  renderDecisions,
  runName,
} from '../../.shared/discoveries.ts';
import { gitOrThrow } from '../../.shared/git.ts';
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

function readDecisions(): DecisionRecord[] {
  return stateDocuments(DECISIONS_PREFIX).map(({ name, value }) => parseDecisionRecord(name, value));
}

/** Claim the run for this pass: false when another pass holds it or won the write. */
function claimRun(runId: string, self: string, at: string): boolean {
  const name = runName(runId);
  const stored = stateGet(name);
  const held = parseRunClaim(name, stored.value)?.claim ?? null;
  if (held !== null && held.run_id !== self) {
    const status = runStatus(held.run_id);
    if (claimDisposition(status) === 'hold') {
      if (status === null) note(`${name} stays claimed: the engine reports no status for run ${held.run_id}`);
      return false;
    }
  }
  return statePut(name, { version: 1, claim: { run_id: self, at } }, stored.revision) === 'ok';
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
  const sha = gitOrThrow('rev-parse', base.ref);
  const decisions = readDecisions();
  const settled = decidedRefs(decisions);
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
    const records = relayed.records
      .map(record => ({ ...record, ref: `${id}:${record.ref}` }))
      .filter(record => !settled.has(record.ref));
    if (records.length === 0) continue;
    if (!claimRun(id, self, at)) continue;
    queue.push({
      id,
      workflow: typeof run.workflow_name === 'string' ? run.workflow_name : '',
      completed_at: run.completed_at as string,
      artifacts,
      records,
    });
  }

  const drain = join(artifactsDir(), 'drain');
  mkdirSync(drain, { recursive: true });
  writeFileSync(
    join(drain, 'queue.json'),
    `${JSON.stringify({ base: { branch: base.branch, sha }, runs: queue }, null, 2)}\n`
  );
  writeFileSync(join(drain, 'discovery-decisions.md'), renderDecisions(decisions));
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
