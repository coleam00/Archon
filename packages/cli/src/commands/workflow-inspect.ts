import { existsSync, readdirSync, type Dirent } from 'node:fs';
import * as archonPaths from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { join } from 'node:path';
import type {
  RunWaitResult,
  UnknownOwnerLiveness,
} from '@archon/core/services/run-attention-watch';
import {
  isApprovalContext,
  isScheduledWorkflowResume,
  isWorkflowWaitContext,
  readRunStopReason,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import type { getTerminalRecord } from '@archon/workflows/terminal-record';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  RunAttention,
  ExecutionOwnerRecord,
  WorkflowWaitContext,
} from '@archon/workflows/schemas/workflow-run';
import { attentionAnswerLines } from '@archon/workflows/deps';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { writeStderr } from '../utils/stdout';
import { formatAge, getLog } from './workflow-shared';
import { printVerboseNodes } from './workflow-node-summaries';

export function usageLimitWaitLine(nodeId: string, resumeAt: string): string {
  return `  Wait:   provider usage or rate limit at '${nodeId}' — tries again at ${resumeAt}`;
}

export function formatToolAttention(
  attention: Extract<RunAttention, { kind: 'stalled_tool_calls' }>
): string {
  return (
    `Run ${attention.runId} is still running; tool calls need attention:\n` +
    attention.calls
      .map(
        call =>
          `  ${call.nodeId} · ${call.provider} · ${call.name}: ${call.title || call.name} (running ${Math.floor(call.elapsedMs / 1000)}s; no progress ${Math.floor(call.stalledForMs / 1000)}s)`
      )
      .join('\n') +
    `\nInspect with archon workflow logs ${attention.runId}, or request recovery with archon workflow end-turn ${attention.runId}.`
  );
}

/**
 * One human-readable line naming the run and what it needs.
 *
 * `awaiting_response` deliberately names TWO runs when they differ: a parent blocked on
 * a sub-run wakes on the child's gate, and the address in the value is the whole
 * reason the caller can act on it.
 */
export function formatWaitOutcome(watchedRunId: string, result: RunWaitResult): string {
  switch (result.kind) {
    case 'deadline':
      return `Timed out waiting on run ${watchedRunId} — still ${result.observedStatus}.`;
    case 'aborted':
      return `Stopped waiting on run ${watchedRunId}.`;
    case 'not_found':
      return `Workflow run not found: ${watchedRunId}`;
    case 'owner_lost':
      return (
        `Run ${watchedRunId} lost its execution owner while still ${result.observedStatus}. ` +
        'The run was not changed. After verifying its work has stopped, run: ' +
        `archon workflow abandon ${watchedRunId}`
      );
    case 'attention':
      break;
  }
  const attention = result.attention;
  switch (attention.kind) {
    case 'stalled_tool_calls':
      return formatToolAttention(attention);
    case 'terminal':
      return `Run ${watchedRunId} ${attention.status}.`;
    case 'awaiting_response':
      return attention.respondTo.runId === watchedRunId
        ? `Run ${watchedRunId} is waiting for a response at gate '${attention.respondTo.nodeId}'.`
        : `Run ${watchedRunId} is blocked on sub-run ${attention.respondTo.runId}, which is waiting ` +
            `for a response at gate '${attention.respondTo.nodeId}'.`;
    case 'attention':
      return [
        `Run ${watchedRunId} needs attention: ${attention.message}`,
        ...attentionAnswerLines(CLI_WORKFLOW_SURFACE, attention),
      ].join('\n');
    case 'blocked_on_child':
      // Unreachable through the waiter, which resolves the chain before returning.
      return `Run ${watchedRunId} is blocked on sub-run ${attention.childRunId}.`;
    case 'blocked_on_children':
      // Unreachable through the waiter, which resolves every child before returning.
      return `Run ${watchedRunId} is blocked on sub-runs ${attention.childRunIds.join(', ')}.`;
    case 'usage_limit':
      return (
        `Run ${watchedRunId} hit a provider usage or rate limit and tries again by itself at ` +
        `${attention.resumeAt}.`
      );
    case 'unreadable':
      return `Run ${watchedRunId} needs a look: ${attention.detail}.`;
  }
}

/**
 * Say once, on stderr, that the wait is now watching the run.
 *
 * Until this line the command is completely silent, and neither a human nor a host
 * can tell an attached wait from one still resolving the id — or from one that died
 * on the way. It also fixes the instant the watch began: a transition after this line
 * reached the caller as a wake, where the same transition before it would have been
 * an ordinary read of an already-settled row.
 *
 * stderr, not stdout, because `--json` promises exactly one document on stdout. The
 * shape follows the same split as the answer itself: the JSON envelope for a machine,
 * one plain sentence for a person.
 *
 * Through `writeStderr` rather than `console.error`/`console.warn`, and awaited: this
 * line exists to tell a host when the watch began, and `console.error` to a pipe whose
 * reader has gone is a silent no-op under Bun. A line that can vanish without a trace
 * cannot carry an ordering.
 */
export function announceWaitAttached(
  watchedRunId: string,
  observedStatus: WorkflowRunStatus,
  json?: boolean,
  ownerLiveness?: UnknownOwnerLiveness
): Promise<void> {
  const recordedOwner = ownerLiveness?.recordedOwner;
  const line = json
    ? JSON.stringify({
        ok: true,
        action: 'wait',
        runId: watchedRunId,
        result: 'waiting',
        observedStatus,
        ...(ownerLiveness ? { ownerLiveness: ownerLiveness.kind } : {}),
        ...(recordedOwner ? { recordedOwner } : {}),
      })
    : `Waiting on run ${watchedRunId} — currently ${observedStatus}.${
        ownerLiveness ? ` ${describeUnknownOwner(recordedOwner)}` : ''
      }`;
  return writeStderr(`${line}\n`);
}

function describeUnknownOwner(owner: ExecutionOwnerRecord | undefined): string {
  if (!owner)
    return 'It records no execution owner, so whether its owner is still alive is unknown.';
  const uid = owner.uid === undefined ? '' : ` (uid ${String(owner.uid)})`;
  return `Its owner ran on host ${owner.host}${uid}, whose endpoint this host cannot reach, so whether it is still alive is unknown.`;
}

/** One line for the checkout a run started from (#3305); `--json` carries the full record. */
export function describeCheckoutBaseline(baseline: WorkflowRun['checkout_baseline']): string {
  if (baseline === null) return '(not recorded)';
  switch (baseline.kind) {
    case 'not_git':
      return 'not a Git checkout';
    case 'unavailable':
      return `checkout unavailable (${baseline.reason})`;
    case 'git': {
      const worktree = baseline.worktree;
      const state =
        worktree.status === 'clean'
          ? 'clean'
          : `dirty: ${String(worktree.staged)} staged, ${String(worktree.unstaged)} unstaged, ${String(worktree.untracked)} untracked` +
            (worktree.content === 'incomplete' ? ', content not fully identified' : '');
      const cut =
        baseline.cutFromCommit !== undefined ? `, branch cut from ${baseline.cutFromCommit}` : '';
      return `${baseline.commit ?? '(unborn branch)'} (${state}${cut})`;
    }
  }
}

/**
 * The `Stopped:` line for a run a signal ended, or null for every other stop reason.
 *
 * Only `process_terminated` gets prose here: it is the one stop reason whose whole
 * point is that the run did not break, so an operator reading `failed` needs to be
 * told. The rest are execution failures the `Error:` line already describes, and
 * inventing operator wording for them is nobody's validated language.
 *
 * SIGINT reaching a foreground process is the terminal's interrupt character, so
 * naming the operator there is a fact. A SIGTERM's sender is genuinely unknown —
 * a supervisor, a shell, a `kill` — and the stop reason is never inferred, so it
 * gets neutral wording and lets the signal do the disambiguating.
 */
export function describeRunStopReason(metadata: Record<string, unknown>): string | null {
  const stopReason = readRunStopReason(metadata);
  if (stopReason?.reason !== 'process_terminated') return null;
  const who = stopReason.signal === 'SIGINT' ? 'the operator' : 'a signal';
  const signal = stopReason.signal === undefined ? '' : ` (${stopReason.signal})`;
  return `interrupted by ${who}${signal}`;
}

/**
 * Leave-behind view (#2747): what a run concluded and what it left undone —
 * outcome, branch, worktree (live or gone), adoption chain, and its artifact
 * file list. Artifacts resolve through the persisted `output_root` and are
 * read-only here: the adopting run references them via `$ADOPTED_RUN_DIR`, it
 * never writes into them.
 */
export interface LeaveBehind {
  branch?: string;
  worktree?: string;
  worktreeLive?: boolean;
  adopted_from?: string;
  adopted_by: string[];
  artifactFiles: string[];
  artifactFilesOmitted: ArtifactOmissions;
}

/**
 * What the artifact walk left out of `artifactFiles`, so a reader is never
 * quietly handed a partial list (#3450).
 */
interface ArtifactOmissions {
  /** Files under the engine's own artifacts child, summarized rather than listed. */
  internalFiles: number;
  /** The display cap stopped the listing before the run's files ran out. */
  truncated: boolean;
  /** Directories the walk could not read, relative to `$ARTIFACTS_DIR`. */
  unreadable: string[];
}

/**
 * The run's `$ARTIFACTS_DIR`, or null when its output location cannot be resolved.
 *
 * #3097: route the persisted `output_root` through the shared resolver so the
 * same `ARCHON_HOME` containment check every other persisted-root reader
 * enforces applies here. An unresolvable root (out-of-tree persisted value with
 * no codebase row to re-derive from) yields the same null-root refusal the
 * transcript reader exposes.
 */
export async function resolveRunArtifactsDir(
  host: WorkflowHost,
  run: WorkflowRun
): Promise<string | null> {
  const codebase = run.codebase_id
    ? await host.records.codebases.getCodebase(run.codebase_id)
    : null;
  const root = archonPaths.resolveRunStorageRoot(run, codebase);
  return root ? archonPaths.getRunArtifactsDirForRoot(root, run.id) : null;
}

export async function buildLeaveBehind(host: WorkflowHost, run: WorkflowRun): Promise<LeaveBehind> {
  const leaveBehind: LeaveBehind = {
    adopted_by: [],
    artifactFiles: [],
    artifactFilesOmitted: { internalFiles: 0, truncated: false, unreadable: [] },
  };

  if (run.working_path) {
    leaveBehind.worktree = run.working_path;
    leaveBehind.worktreeLive = existsSync(run.working_path);
  }
  if (run.adopted_from_run_id) leaveBehind.adopted_from = run.adopted_from_run_id;
  leaveBehind.adopted_by = (await host.deps.store.findAdoptingRuns(run.id)).map(r => r.id);

  // Branch from the isolation record that owned the working path, if any.
  if (run.codebase_id && run.working_path) {
    try {
      const envs = await host.records.isolation.listByCodebase(run.codebase_id);
      const env = envs.find(e => e.working_path === run.working_path);
      if (env) leaveBehind.branch = env.branch_name;
    } catch (error) {
      getLog().debug({ err: error as Error }, 'cli.workflow_get_branch_lookup_failed');
    }
  }

  // Artifact file list — operator-facing files, capped for display.
  const artifactsDir = await resolveRunArtifactsDir(host, run);
  if (artifactsDir) {
    try {
      const listing = listArtifactFiles(artifactsDir);
      leaveBehind.artifactFiles = listing.files;
      leaveBehind.artifactFilesOmitted = listing.omitted;
    } catch (error) {
      getLog().debug({ err: error as Error }, 'cli.workflow_get_artifact_walk_failed');
    }
  }
  return leaveBehind;
}

/**
 * The operator-facing files under `dir`, relative and capped for display (#2747).
 *
 * The engine writes its own bookkeeping under `RUN_ARTIFACTS_ENGINE_SUBDIR` —
 * one typed-artifact listing per node invocation, node-output spills — which on
 * a pack run outnumbers the reports a person reads and used to consume the whole
 * cap. Those files are counted rather than listed (#3450); their content is
 * already reachable through the engine's own `nodes/` sidecars.
 *
 * The walk stays exhaustive so the counts are true: it is the same tree the
 * console's artifacts route already walks in full on every run page. Each
 * directory yields its own files before its subdirectories, sorted, so the cap
 * and the human preview fall on nested content rather than on whichever entries
 * `readdir` happened to return first — a run's reports sit at the top level.
 */
export function listArtifactFiles(dir: string, maxFiles = 200): ArtifactListing {
  const files: string[] = [];
  const omitted: ArtifactOmissions = { internalFiles: 0, truncated: false, unreadable: [] };
  const walk = (current: string, prefix: string, internal: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // A directory that is simply gone dropped nothing an operator could open.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') omitted.unreadable.push(prefix);
      return;
    }
    // Order only matters where entries reach the list; inside the engine's child
    // they are counted, and a pack run leaves hundreds of them there.
    if (!internal) entries.sort((left, right) => left.name.localeCompare(right.name));
    const relative = (entry: Dirent): string => (prefix ? `${prefix}/${entry.name}` : entry.name);
    const isEngineOwned = (entry: Dirent): boolean =>
      internal || archonPaths.isRunArtifactsEngineEntry(prefix, entry.name);
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (isEngineOwned(entry)) omitted.internalFiles++;
      else if (files.length >= maxFiles) omitted.truncated = true;
      else files.push(relative(entry));
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(join(current, entry.name), relative(entry), isEngineOwned(entry));
    }
  };
  walk(dir, '', false);
  return { files, omitted };
}

interface ArtifactListing {
  files: string[];
  omitted: ArtifactOmissions;
}

/**
 * Pull the dropped-key warnings out of a run's event log (#2213).
 *
 * The engine records them once at run start as `workflow_parse_warnings`,
 * whatever surface started the run — so this is the read path for a run that
 * had no conversation to post into (CLI, REST) or whose chat delivery failed.
 */
export function readParseWarningEvents(events: readonly WorkflowEventRow[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.event_type !== 'workflow_parse_warnings') continue;
    const raw: unknown = (event.data as Record<string, unknown> | null)?.warnings;
    if (Array.isArray(raw)) out.push(...raw.filter((w): w is string => typeof w === 'string'));
  }
  return out;
}

type TerminalRecord = ReturnType<typeof getTerminalRecord>;

/** The text view of `workflow get`, in its fixed line order. */
export function printRunDetail(
  run: WorkflowRun,
  detail: {
    transcriptPath: string | null;
    terminalRecord: TerminalRecord;
    leaveBehind: LeaveBehind | undefined;
    events: WorkflowEventRow[];
    verbose: boolean | undefined;
  }
): void {
  const { transcriptPath, terminalRecord, leaveBehind, events, verbose } = detail;
  console.log(`  ID:     ${run.id}`);
  console.log(`  Name:   ${run.workflow_name}`);
  console.log(`  Path:   ${run.working_path ?? '(none)'}`);
  console.log(`  Start:  ${describeCheckoutBaseline(run.checkout_baseline)}`);
  console.log(`  Transcript: ${transcriptPath ?? '(unavailable)'}`);
  console.log(`  Status: ${run.status}`);
  if (run.outcome) console.log(`  Authored outcome: ${run.outcome}`);
  console.log(`  Age:    ${formatAge(run.started_at)}`);
  printRunPauseLines(run);
  // Only a failed run's stop reason describes how it ended. A run can leave 'failed'
  // with the key still set (cancelWorkflowRun abandons a failed run without touching
  // metadata), and the console's runStatusLabel applies the same rule.
  const stopped = run.status === 'failed' ? describeRunStopReason(run.metadata) : null;
  if (stopped) {
    console.log(`  Stopped: ${stopped}`);
  }
  const runError = typeof run.metadata.error === 'string' ? run.metadata.error : undefined;
  if (runError) {
    console.log(`  Error:  ${runError}`);
  }
  printTerminalRecord(terminalRecord);
  if (leaveBehind) printLeaveBehind(leaveBehind);
  if (verbose) {
    const parseWarnings = readParseWarningEvents(events);
    if (parseWarnings.length > 0) {
      console.log(`  Ignored keys (${String(parseWarnings.length)}):`);
      for (const w of parseWarnings) console.log(`    - ${w}`);
    }
    printVerboseNodes(events);
  }
}

/** The gate, choices, wait and scheduled-resume lines of a paused or failed run. */
function printRunPauseLines(run: WorkflowRun): void {
  printApprovalGateLines(run);
  printWaitLines(run);
  const scheduledResume = run.metadata.scheduled_resume;
  if (
    run.status === 'failed' &&
    isScheduledWorkflowResume(scheduledResume) &&
    scheduledResume.triggeredAt === undefined
  ) {
    console.log(
      `  Resume: scheduled for ${scheduledResume.resumeAt} (attempt ${String(scheduledResume.attempt)}/${String(scheduledResume.maxAttempts)})`
    );
  }
}

function printApprovalGateLines(run: WorkflowRun): void {
  // Paused interactive-loop gate: one honest line so a human (or an agent parsing
  // the plain output) sees whether any declared completion condition completed
  // the paused iteration (#2074). --json already carries the full metadata.approval.
  const gateMeta = run.metadata.approval;
  const waitMeta = run.metadata.wait;
  if (
    run.status === 'paused' &&
    !isWorkflowWaitContext(waitMeta) &&
    isApprovalContext(gateMeta) &&
    gateMeta.type === 'interactive_loop'
  ) {
    const completionMet = gateMeta.completionSignaled === true ? 'yes' : 'no';
    console.log(
      `  Gate:   awaiting approval — completion condition met: ${completionMet} (iteration ${String(gateMeta.iteration ?? '?')})`
    );
  }
  if (
    run.status === 'paused' &&
    !isWorkflowWaitContext(waitMeta) &&
    isApprovalContext(gateMeta) &&
    gateMeta.type !== 'child_workflow' &&
    gateMeta.type !== 'fan_out' &&
    !gateMeta.resolved
  ) {
    console.log(`  Choices: ${gateMeta.message}`);
    for (const decision of getApprovalDecisions(gateMeta)) {
      const display = decision.label ? `${decision.label} (${decision.id})` : decision.id;
      console.log(`    ${display}: archon workflow respond ${run.id} ${decision.id} [text]`);
    }
  }
}

function printWaitLines(run: WorkflowRun): void {
  const waitMeta = run.metadata.wait;
  if (run.status !== 'paused' || !isWorkflowWaitContext(waitMeta)) return;
  if (waitMeta.kind === 'attention') {
    printAttentionWaitLines(run, waitMeta);
  } else {
    console.log(
      waitMeta.kind === 'event'
        ? `  Wait:   event '${waitMeta.event ?? '?'}' until ${waitMeta.resumeAt}`
        : waitMeta.kind === 'quota'
          ? usageLimitWaitLine(waitMeta.nodeId, waitMeta.resumeAt)
          : `  Wait:   until ${waitMeta.resumeAt}`
    );
  }
}

function printAttentionWaitLines(
  run: WorkflowRun,
  waitMeta: Extract<WorkflowWaitContext, { kind: 'attention' }>
): void {
  const attention = runAttention(run);
  console.log(
    attention?.kind === 'attention'
      ? `  Wait:   needs attention — ${waitMeta.message} (occurrence ${attention.occurrence})`
      : `  Wait:   answered via ${String(waitMeta.answeredVia)} at ${String(waitMeta.answeredAt)}; awaiting continuation`
  );
  if (attention?.kind === 'attention')
    for (const line of attentionAnswerLines(CLI_WORKFLOW_SURFACE, attention))
      console.log(`    ${line}`);
}

function printTerminalRecord(terminalRecord: TerminalRecord): void {
  if (terminalRecord) {
    console.log('  Terminal record:');
    if (terminalRecord.first_failed_node) {
      console.log(`    First failed node: ${terminalRecord.first_failed_node}`);
    }
    console.log(`    Selected return: ${terminalRecord.returns.availability}`);
    console.log(`    Artifacts observed: ${String(terminalRecord.artifacts.files.length)}`);
    for (const file of terminalRecord.artifacts.files) console.log(`      - ${file.path}`);
    for (const limitation of terminalRecord.artifacts.limitations) {
      console.log(`    Inventory limitation: ${limitation.kind} (${limitation.path})`);
    }
  } else {
    console.log('  Terminal record: (unavailable)');
  }
}

function printLeaveBehind(leaveBehind: LeaveBehind): void {
  console.log('  Leave-behind:');
  if (leaveBehind.branch) console.log(`    Branch: ${leaveBehind.branch}`);
  if (leaveBehind.worktree) {
    console.log(
      `    Worktree: ${leaveBehind.worktree} (${leaveBehind.worktreeLive ? 'live' : 'gone'})`
    );
  }
  if (leaveBehind.adopted_from) console.log(`    Adopted from: ${leaveBehind.adopted_from}`);
  for (const a of leaveBehind.adopted_by) console.log(`    Adopted by: ${a}`);
  printLeaveBehindArtifacts(leaveBehind);
}

function printLeaveBehindArtifacts(leaveBehind: LeaveBehind): void {
  if (leaveBehind.artifactFiles.length > 0) {
    console.log(
      `    Artifacts (${String(leaveBehind.artifactFiles.length)} files under $ARTIFACTS_DIR):`
    );
    for (const f of leaveBehind.artifactFiles.slice(0, 20)) console.log(`      - ${f}`);
    if (leaveBehind.artifactFiles.length > 20) console.log('      …');
  }
  const omitted = leaveBehind.artifactFilesOmitted;
  if (omitted.internalFiles > 0) {
    console.log(
      `    Engine-internal artifact files (not listed): ${String(omitted.internalFiles)}`
    );
  }
  if (omitted.truncated) console.log('    Artifact list truncated at the display cap');
  for (const path of omitted.unreadable) {
    console.log(`    Unreadable artifact directory: ${path === '' ? '$ARTIFACTS_DIR' : path}`);
  }
}
