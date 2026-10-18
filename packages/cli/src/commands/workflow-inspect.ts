import { existsSync, readdirSync, type Dirent } from 'node:fs';
import * as archonPaths from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { join } from 'node:path';
import type {
  RunWaitResult,
  UnknownOwnerLiveness,
} from '@archon/core/services/run-attention-watch';
import { readRunStopReason } from '@archon/workflows/schemas/workflow-run';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  RunAttention,
  ExecutionOwnerRecord,
} from '@archon/workflows/schemas/workflow-run';
import { attentionAnswerLines } from '@archon/workflows/deps';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { writeStderr } from '../utils/stdout';
import { getLog } from './workflow-shared';

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
    `\nInspect with archon workflow logs ${attention.runId}, or explicitly cancel the run.`
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

export async function buildLeaveBehind(host: WorkflowHost, run: WorkflowRun): Promise<LeaveBehind> {
  const codebase = run.codebase_id
    ? await host.records.codebases.getCodebase(run.codebase_id)
    : null;

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
  // #3097: route the persisted `output_root` through the shared resolver so
  // the same `ARCHON_HOME` containment check every other persisted-root
  // reader in this file already enforces applies here. An unresolvable root
  // (out-of-tree persisted value with no codebase row to re-derive from)
  // yields the same null-root refusal the transcript reader exposes.
  const artifactsRoot = archonPaths.resolveRunStorageRoot(run, codebase);
  if (artifactsRoot) {
    try {
      const artifactsDir = archonPaths.getRunArtifactsDirForRoot(artifactsRoot, run.id);
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
function listArtifactFiles(dir: string, maxFiles = 200): ArtifactListing {
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
