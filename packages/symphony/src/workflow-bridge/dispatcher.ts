/**
 * Symphony → Archon workflow-run launch.
 *
 * Phase 3 replacement for the Phase 2 stub. Given a candidate issue, this:
 *
 *   1. Hard-fails if no codebase is mapped (writes a `failed` dispatch row).
 *   2. Resolves the workflow definition by name from `state_workflow_map`.
 *   3. Inserts a `pending` dispatch row.
 *   4. Creates a hidden worker conversation (`platform = 'web'`,
 *      `platform_conversation_id = symphony-…`) and resolves a worktree.
 *   5. Pre-creates the workflow_run via the workflow store, attaches its id to
 *      the dispatch row, transitions the row to `running`.
 *   6. Fires `executeWorkflow(...)` (fire-and-forget); terminal status comes
 *      back through the workflow event emitter, handled by the orchestrator.
 *
 * The dispatcher does NOT subscribe to events — that's the orchestrator's job
 * (it owns the in-memory state and the retry scheduler). The dispatcher's
 * return value tells the orchestrator what state mutation to perform.
 */
import type { IDatabase } from '@archon/core/db';
import { createLogger } from '@archon/paths';
import { attachWorkflowRun, insertDispatch, updateStatus } from '../db/dispatches';
import type { Issue } from '../tracker/types';
import type { ConfigSnapshot, TrackerKind } from '../config/snapshot';
import type { BridgeDeps, DispatchInput, DispatchOutcome } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.dispatcher');
  return cachedLog;
}

/**
 * Build a platform conversation id that is filesystem- and URL-safe. Linear
 * dispatch keys look like `linear:APP-292`; GitHub keys look like
 * `github:owner/repo#42`. We replace `:`, `/`, and `#` with `-` to stay safe
 * everywhere.
 */
export function buildWorkerPlatformId(
  dispatchKey: string,
  timestampMs: number,
  random: string
): string {
  const safe = dispatchKey.replace(/[:/#]+/g, '-');
  return `symphony-${safe}-${String(timestampMs)}-${random}`;
}

function repoLabelForIssue(trackerKind: TrackerKind, issue: Issue, snap: ConfigSnapshot): string {
  if (trackerKind === 'github') {
    const hash = issue.identifier.indexOf('#');
    return hash > 0 ? issue.identifier.slice(0, hash) : issue.identifier;
  }
  // Linear: `tracker.repository` is the only meaningful repo label upstream.
  // We surface it here for the no-codebase error message; the orchestrator
  // already does the codebases[] lookup.
  const linearCfg = snap.trackers.find(t => t.kind === 'linear');
  return linearCfg?.kind === 'linear' ? (linearCfg.repository ?? '<no repository>') : '<unknown>';
}

function renderUserMessage(issue: Issue): string {
  const lines: string[] = [];
  lines.push(`# ${issue.identifier}: ${issue.title}`);
  if (issue.url) lines.push(`URL: ${issue.url}`);
  if (issue.labels && issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(', ')}`);
  }
  lines.push('');
  lines.push(issue.description ?? '');
  return lines.join('\n').trim();
}

/**
 * Launch one issue into the Archon workflow engine.
 *
 * Caller (orchestrator) is responsible for:
 *   - the in-memory `RunningEntry` lifecycle
 *   - the `runIdToDispatchKey` map for terminal-event reverse lookup
 *   - retry scheduling on `failed_*` outcomes
 *
 * The dispatcher only owns the DB row and the workflow launch sequence.
 */
export async function dispatchToWorkflow(
  db: IDatabase,
  bridge: BridgeDeps,
  input: DispatchInput
): Promise<DispatchOutcome> {
  const log = getLog();
  const { issue, trackerKind, snap, attempt, codebaseId } = input;
  const dispatchKey = `${trackerKind}:${issue.identifier}`;

  // 1. Resolve workflow name + codebase before any DB writes
  const workflowName = snap.stateWorkflowMap[issue.state];
  if (!workflowName) {
    log.warn(
      { dispatch_key: dispatchKey, identifier: issue.identifier, state: issue.state },
      'symphony.dispatch_no_workflow_for_state'
    );
    return {
      status: 'failed_no_workflow',
      reason: `no workflow mapped for state '${issue.state}'`,
    };
  }

  // Codebase is required — fail-fast per CLAUDE.md, no fallback to live checkout.
  if (!codebaseId) {
    const repo = repoLabelForIssue(trackerKind, issue, snap);
    const reason = `no codebase mapped for ${trackerKind}:${repo}`;
    log.warn(
      {
        dispatch_key: dispatchKey,
        identifier: issue.identifier,
        tracker: trackerKind,
        repository: repo,
      },
      'symphony.dispatch_no_codebase'
    );
    try {
      await insertDispatch(db, {
        issue_id: issue.id,
        identifier: issue.identifier,
        tracker: trackerKind,
        dispatch_key: dispatchKey,
        codebase_id: null,
        workflow_name: workflowName,
        workflow_run_id: null,
        attempt,
        status: 'failed',
        last_error: reason,
      });
    } catch (e) {
      // Duplicate dispatch_key is the only expected failure. Treat as a
      // no-op: a previous run already recorded this issue's outcome.
      log.warn(
        { dispatch_key: dispatchKey, err: (e as Error).message },
        'symphony.dispatch_db_conflict'
      );
      return { status: 'failed_db_conflict', reason: (e as Error).message };
    }
    return { status: 'failed_no_codebase', reason };
  }

  const codebase = await bridge.loadCodebase(codebaseId);
  if (!codebase) {
    const reason = `codebase ${codebaseId} not found`;
    log.warn(
      { dispatch_key: dispatchKey, codebase_id: codebaseId },
      'symphony.dispatch_codebase_missing'
    );
    try {
      await insertDispatch(db, {
        issue_id: issue.id,
        identifier: issue.identifier,
        tracker: trackerKind,
        dispatch_key: dispatchKey,
        codebase_id: null,
        workflow_name: workflowName,
        workflow_run_id: null,
        attempt,
        status: 'failed',
        last_error: reason,
      });
    } catch (e) {
      log.warn(
        { dispatch_key: dispatchKey, err: (e as Error).message },
        'symphony.dispatch_db_conflict'
      );
      return { status: 'failed_db_conflict', reason: (e as Error).message };
    }
    return { status: 'failed_no_codebase', reason };
  }

  // 2. Insert pending row before any side-effects so the row is durable even
  //    if isolation/createWorkflowRun throws.
  let dispatchId: string;
  try {
    const inserted = await insertDispatch(db, {
      issue_id: issue.id,
      identifier: issue.identifier,
      tracker: trackerKind,
      dispatch_key: dispatchKey,
      codebase_id: codebaseId,
      workflow_name: workflowName,
      workflow_run_id: null,
      attempt,
      status: 'pending',
    });
    dispatchId = inserted.id;
  } catch (e) {
    log.warn(
      { dispatch_key: dispatchKey, err: (e as Error).message },
      'symphony.dispatch_db_conflict'
    );
    return { status: 'failed_db_conflict', reason: (e as Error).message };
  }

  // 3. Resolve workflow definition. If discovery fails, mark the row failed.
  let workflowDefinition;
  try {
    workflowDefinition = await bridge.resolveWorkflow(workflowName, codebase.default_cwd);
  } catch (e) {
    const reason = `workflow lookup failed: ${(e as Error).message}`;
    await updateStatus(db, dispatchId, 'failed', reason).catch(() => undefined);
    log.error(
      { dispatch_key: dispatchKey, workflow: workflowName, err: (e as Error).message },
      'symphony.dispatch_workflow_lookup_failed'
    );
    return { status: 'failed_no_workflow', reason };
  }
  if (!workflowDefinition) {
    const reason = `workflow '${workflowName}' not found in cwd ${codebase.default_cwd}`;
    await updateStatus(db, dispatchId, 'failed', reason).catch(() => undefined);
    log.warn(
      { dispatch_key: dispatchKey, workflow: workflowName, cwd: codebase.default_cwd },
      'symphony.dispatch_workflow_missing'
    );
    return { status: 'failed_no_workflow', reason };
  }

  // 4. Create worker conversation + resolve isolation
  const now = bridge.now ?? Date.now;
  const platformId = buildWorkerPlatformId(
    dispatchKey,
    now(),
    Math.random().toString(36).slice(2, 8)
  );
  let conv;
  let cwd: string;
  try {
    conv = await bridge.createWorkerConversation({
      platformConversationId: platformId,
      codebaseId,
      cwd: codebase.default_cwd,
    });
    const isolation = await bridge.resolveIsolation({
      conversation: conv,
      codebase,
      platform: bridge.platform,
    });
    cwd = isolation.cwd;
  } catch (e) {
    const reason = `worker setup failed: ${(e as Error).message}`;
    await updateStatus(db, dispatchId, 'failed', reason).catch(() => undefined);
    log.error(
      { dispatch_key: dispatchKey, err: (e as Error).message },
      'symphony.dispatch_worker_setup_failed'
    );
    return { status: 'failed_no_workflow', reason };
  }

  bridge.platform.setConversationDbId(platformId, conv.id);

  // 5. Pre-create the workflow run row, attach it to the dispatch
  let preCreatedRunId: string;
  try {
    const run = await bridge.workflowDeps.store.createWorkflowRun({
      workflow_name: workflowName,
      conversation_id: conv.id,
      codebase_id: codebaseId,
      user_message: renderUserMessage(issue),
      working_path: cwd,
      metadata: {
        symphony: {
          dispatch_id: dispatchId,
          dispatch_key: dispatchKey,
          tracker: trackerKind,
          identifier: issue.identifier,
          attempt,
        },
      },
    });
    preCreatedRunId = run.id;
  } catch (e) {
    const reason = `pre-create run failed: ${(e as Error).message}`;
    await updateStatus(db, dispatchId, 'failed', reason).catch(() => undefined);
    log.error(
      { dispatch_key: dispatchKey, err: (e as Error).message },
      'symphony.dispatch_pre_create_failed'
    );
    return { status: 'failed_no_workflow', reason };
  }

  try {
    await attachWorkflowRun(db, dispatchId, preCreatedRunId);
    await updateStatus(db, dispatchId, 'running');
  } catch (e) {
    log.error(
      { dispatch_key: dispatchKey, err: (e as Error).message },
      'symphony.dispatch_attach_failed'
    );
    // The run row exists upstream but we can't remember it. Surface failure
    // and let the orchestrator schedule a retry.
    return {
      status: 'failed_no_workflow',
      reason: `attach run id failed: ${(e as Error).message}`,
    };
  }

  log.info(
    {
      dispatch_id: dispatchId,
      dispatch_key: dispatchKey,
      identifier: issue.identifier,
      tracker: trackerKind,
      workflow: workflowName,
      codebase_id: codebaseId,
      cwd,
      workflow_run_id: preCreatedRunId,
      attempt,
    },
    'symphony.dispatch_launched'
  );

  // 6. Fire-and-forget; terminal status arrives via the event emitter, owned
  //    by the orchestrator's listener.
  void bridge
    .runWorkflow({
      workflow: workflowDefinition,
      workerPlatformId: platformId,
      workerConversationDbId: conv.id,
      cwd,
      codebaseId,
      userMessage: renderUserMessage(issue),
      preCreatedRunId,
      signal: input.abort.signal,
    })
    .catch((err: unknown) => {
      // executeWorkflow handles its own failures via event emission. Catching
      // here is belt-and-suspenders for synchronous setup throws inside the
      // executor wrapper.
      log.error(
        {
          dispatch_id: dispatchId,
          dispatch_key: dispatchKey,
          err: err as Error,
        },
        'symphony.dispatch_execute_threw'
      );
    });

  return {
    status: 'launched',
    dispatchId,
    workflowRunId: preCreatedRunId,
  };
}
