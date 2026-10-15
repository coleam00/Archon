/**
 * Build this pass's queue: the finished runs whose discoveries no pass has decided,
 * every decision made so far, and the base commit claims are checked against.
 *
 * A run's records become final when the run reaches a terminal status, so only
 * terminal runs are queued, oldest first. In live mode each queued run is claimed with
 * a conditional write on its `discoveries/runs/<id>` document, so two passes never
 * decide the same run. A claim is released only when the claiming run is terminal.
 * Eval mode writes nothing and reads no run document: it decides the window's runs as
 * if no pass had seen them, against whatever decisions are already stored.
 *
 * Writes `$ARTIFACTS_DIR/drain/queue.json` (the queued records, for the agent and the
 * outcome) and `$ARTIFACTS_DIR/drain/discovery-decisions.md` (every stored decision).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DECISIONS_PREFIX,
  type DecisionRecord,
  parseDrainMode,
  parseDecisionRecord,
  parseRunDoc,
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
  stateGet,
  stateList,
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
  return stateList(DECISIONS_PREFIX).flatMap(name => {
    const value = stateGet(name).value;
    return value === null ? [] : [parseDecisionRecord(name, value)];
  });
}

/**
 * Claim the run for this pass, or say why not. The claim keeps the refs earlier
 * passes already decided, so a run that came back only for its asked records is
 * decided only for those.
 */
function claimRun(runId: string, self: string, at: string): readonly string[] | null {
  const name = runName(runId);
  const stored = stateGet(name);
  const doc = parseRunDoc(name, stored.value);
  if (doc?.claim !== undefined && doc.claim !== null && doc.claim.run_id !== self) {
    const status = runStatus(doc.claim.run_id);
    if (claimDisposition(status) === 'hold') {
      if (status === null) note(`${name} stays claimed: the engine reports no status for run ${doc.claim.run_id}`);
      return null;
    }
  }
  const next = { version: 1, claim: { run_id: self, at }, decided: doc?.decided ?? {} };
  return statePut(name, next, stored.revision) === 'ok' ? Object.keys(next.decided) : null;
}

function main(): void {
  // Every input is validated before anything is read or written.
  const mode = parseDrainMode(trimmed(process.env.INPUTS_MODE));
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
  const at = new Date().toISOString();

  const listed = listRuns(LISTING);
  if (listed.length >= LISTING) {
    note(`only the newest ${String(LISTING)} runs are listed; older runs are not drained in this pass`);
  }
  const candidates = listed
    .filter(run => typeof run.id === 'string' && run.id !== self)
    .filter(run => typeof run.status === 'string' && TERMINAL.includes(run.status))
    .map(run => ({ run, completed: typeof run.completed_at === 'string' ? Date.parse(run.completed_at) : Number.NaN }))
    .filter(({ completed }) => !Number.isNaN(completed))
    .filter(({ completed }) => (since === undefined || completed >= since) && (until === undefined || completed <= until))
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
    if (relayed.records.length === 0) continue;
    let decided: readonly string[] = [];
    if (mode === 'live') {
      // Skip before claiming a run every record of which is already decided.
      const doc = parseRunDoc(runName(id), stateGet(runName(id)).value);
      if (doc !== null && relayed.records.every(record => record.ref in doc.decided)) continue;
      const claimed = claimRun(id, self, at);
      if (claimed === null) continue;
      decided = claimed;
    }
    const records = relayed.records
      .filter(record => !decided.includes(record.ref))
      .map(record => ({ ...record, ref: `${id}:${record.ref}` }));
    if (records.length === 0) continue;
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
    `${JSON.stringify({ mode, base: { branch: base.branch, sha }, runs: queue }, null, 2)}\n`
  );
  writeFileSync(join(drain, 'discovery-decisions.md'), renderDecisions(decisions));
  emit({
    path: queue.length === 0 ? 'idle' : 'decide',
    mode,
    base: { branch: base.branch, sha },
    runs: queue.map(run => run.id),
    refs: queue.reduce((count, run) => count + run.records.length, 0),
    decisions: decisions.length,
    policy_defaults: POLICY_DEFAULTS,
  });
}

try {
  main();
} catch (error) {
  refuse(`discoveries facts: ${error instanceof Error ? error.message : String(error)}`);
}
