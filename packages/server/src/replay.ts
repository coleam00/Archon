/**
 * Mission Control replay support.
 *
 * Two modes:
 *   - preview: returns a drift block (current YAML hash + repo HEAD) so the UI
 *     can warn the operator before re-execution.
 *   - confirm: pre-creates a new workflow_run linked back to the original via
 *     replay_of_run_id, resolves a fresh isolation environment, and fires
 *     executeWorkflow in the background.
 *
 * Replay is intentionally thin: it reuses the existing workflow engine
 * primitives (createWorkflowDeps, validateAndResolveIsolation, executeWorkflow)
 * that other dispatch paths already exercise.
 */
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import { validateAndResolveIsolation } from '@archon/core/orchestrator';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { execFileAsync } from '@archon/git';
import {
  createLogger,
  getWorkflowFolderSearchPaths,
  getArchonHome,
  getDefaultWorkflowsPath,
} from '@archon/paths';
import { parseWorkflow } from '@archon/workflows/loader';
import { BUNDLED_WORKFLOWS, isBinaryBuild } from '@archon/workflows/defaults';
import { executeWorkflow } from '@archon/workflows/executor';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WebAdapter } from './adapters/web';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('mission.replay');
  return cachedLog;
}

export interface ReplayDrift {
  yaml_changed: boolean;
  repo_head_changed: boolean;
  current_yaml_hash: string;
  original_yaml_hash: string | null;
  current_repo_head: string | null;
  original_repo_head: string | null;
}

export interface ReplayPreview {
  original_run_id: string;
  workflow_name: string;
  drift: ReplayDrift;
}

export interface ReplayLaunchResult {
  new_run_id: string;
  new_conversation_id: string;
  workflow_name: string;
  drift: ReplayDrift;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Locate and read the workflow YAML for the given workflow name. Returns null
 * if the workflow cannot be resolved on disk or in the bundled defaults map.
 * Tries: project (cwd/.archon/workflows), home, bundled, default-folder fallback.
 */
async function readWorkflowYaml(
  workflowName: string,
  cwd: string | null
): Promise<{ content: string; source: 'project' | 'global' | 'bundled' } | null> {
  const filename = `${workflowName}.yaml`;
  if (cwd) {
    const [folder] = getWorkflowFolderSearchPaths();
    try {
      const content = await readFile(join(cwd, folder, filename), 'utf-8');
      return { content, source: 'project' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLog().warn({ err, workflowName, cwd }, 'mission.replay.project_read_failed');
      }
    }
  }
  try {
    const content = await readFile(join(getArchonHome(), 'workflows', filename), 'utf-8');
    return { content, source: 'global' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLog().warn({ err, workflowName }, 'mission.replay.home_read_failed');
    }
  }
  if (Object.hasOwn(BUNDLED_WORKFLOWS, workflowName)) {
    return { content: BUNDLED_WORKFLOWS[workflowName] ?? '', source: 'bundled' };
  }
  if (!isBinaryBuild()) {
    try {
      const content = await readFile(join(getDefaultWorkflowsPath(), filename), 'utf-8');
      return { content, source: 'bundled' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLog().warn({ err, workflowName }, 'mission.replay.default_read_failed');
      }
    }
  }
  return null;
}

async function getCurrentRepoHead(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return result.stdout.trim() || null;
  } catch (err) {
    getLog().warn({ err: err as Error, cwd }, 'mission.replay.git_head_failed');
    return null;
  }
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const v = metadata[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function computeDrift(run: WorkflowRun, yamlContent: string): Promise<ReplayDrift> {
  const currentYamlHash = sha256(yamlContent);
  const originalYamlHash = readMetadataString(run.metadata, 'replay_yaml_hash');
  const originalRepoHead = readMetadataString(run.metadata, 'replay_repo_head');

  const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
  const cwd = codebase?.default_cwd ?? null;
  const currentRepoHead = await getCurrentRepoHead(cwd);

  return {
    yaml_changed: originalYamlHash !== null && originalYamlHash !== currentYamlHash,
    repo_head_changed:
      originalRepoHead !== null && currentRepoHead !== null && originalRepoHead !== currentRepoHead,
    current_yaml_hash: currentYamlHash,
    original_yaml_hash: originalYamlHash,
    current_repo_head: currentRepoHead,
    original_repo_head: originalRepoHead,
  };
}

/** Build a preview drift block without launching a replay. */
export async function buildReplayPreview(
  runId: string
): Promise<
  { ok: true; preview: ReplayPreview } | { ok: false; status: 404 | 400 | 500; error: string }
> {
  const run = await workflowDb.getWorkflowRun(runId);
  if (!run) return { ok: false, status: 404, error: 'Workflow run not found' };

  const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
  const cwd = codebase?.default_cwd ?? null;
  const yamlEntry = await readWorkflowYaml(run.workflow_name, cwd);
  if (!yamlEntry) {
    return {
      ok: false,
      status: 404,
      error: `Workflow definition '${run.workflow_name}' not found on disk`,
    };
  }
  const drift = await computeDrift(run, yamlEntry.content);
  return {
    ok: true,
    preview: {
      original_run_id: run.id,
      workflow_name: run.workflow_name,
      drift,
    },
  };
}

/**
 * Pre-create a new workflow_run with `replay_of_run_id` set, resolve a fresh
 * isolation environment, and fire executeWorkflow in the background. Returns
 * immediately so the HTTP request finishes quickly; the run progresses via
 * the workflow event emitter.
 */
export async function launchReplay(
  runId: string,
  webAdapter: WebAdapter
): Promise<
  { ok: true; result: ReplayLaunchResult } | { ok: false; status: 400 | 404 | 500; error: string }
> {
  const log = getLog();
  const run = await workflowDb.getWorkflowRun(runId);
  if (!run) return { ok: false, status: 404, error: 'Workflow run not found' };
  if (!run.codebase_id) {
    return {
      ok: false,
      status: 400,
      error: 'Replay requires the original run to be linked to a codebase',
    };
  }
  const codebase = await codebaseDb.getCodebase(run.codebase_id);
  if (!codebase) {
    return { ok: false, status: 404, error: 'Codebase for original run not found' };
  }

  const yamlEntry = await readWorkflowYaml(run.workflow_name, codebase.default_cwd);
  if (!yamlEntry) {
    return {
      ok: false,
      status: 404,
      error: `Workflow definition '${run.workflow_name}' not found on disk`,
    };
  }
  const parsed = parseWorkflow(yamlEntry.content, `${run.workflow_name}.yaml`);
  if (parsed.error || !parsed.workflow) {
    return {
      ok: false,
      status: 400,
      error: `Workflow definition is invalid: ${parsed.error?.error ?? 'unknown'}`,
    };
  }
  const workflow: WorkflowDefinition = parsed.workflow;

  const drift = await computeDrift(run, yamlEntry.content);

  // Build a unique worker conversation for the replay.
  const platformConversationId = `mission-replay-${run.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const workerConv = await conversationDb.getOrCreateConversation(
    'web',
    platformConversationId,
    run.codebase_id
  );
  await conversationDb.updateConversation(workerConv.id, {
    cwd: codebase.default_cwd,
    codebase_id: run.codebase_id,
    hidden: true,
  });

  // Resolve a fresh isolation environment.
  let cwd: string;
  try {
    const conv = await conversationDb.findConversationByPlatformId(platformConversationId);
    if (!conv) {
      throw new Error('worker conversation disappeared between create and isolation resolve');
    }
    const isolation = await validateAndResolveIsolation(
      conv,
      codebase,
      webAdapter as Parameters<typeof validateAndResolveIsolation>[2],
      platformConversationId,
      { workflowType: 'thread', workflowId: platformConversationId }
    );
    cwd = isolation.cwd;
  } catch (e) {
    const err = e as Error;
    log.error(
      { err, runId, codebaseId: run.codebase_id },
      'mission.replay.isolation_resolve_failed'
    );
    return { ok: false, status: 500, error: `Isolation resolution failed: ${err.message}` };
  }

  webAdapter.setConversationDbId(platformConversationId, workerConv.id);

  // Pre-create the new workflow run row with the replay backlink.
  let preCreatedRun: WorkflowRun;
  try {
    preCreatedRun = await workflowDeps().store.createWorkflowRun({
      workflow_name: run.workflow_name,
      conversation_id: workerConv.id,
      codebase_id: run.codebase_id,
      user_message: run.user_message,
      working_path: cwd,
      replay_of_run_id: run.id,
      metadata: {
        replay_of_run_id: run.id,
        replay_yaml_hash: drift.current_yaml_hash,
        replay_repo_head: drift.current_repo_head ?? null,
      },
    });
  } catch (e) {
    const err = e as Error;
    log.error({ err, runId }, 'mission.replay.pre_create_failed');
    return { ok: false, status: 500, error: `Failed to create replay run: ${err.message}` };
  }

  log.info(
    {
      original_run_id: run.id,
      new_run_id: preCreatedRun.id,
      workflow: run.workflow_name,
      cwd,
      yaml_changed: drift.yaml_changed,
      repo_head_changed: drift.repo_head_changed,
    },
    'mission.replay.launched'
  );

  // Fire-and-forget executeWorkflow; the workflow event emitter will fire
  // terminal events that the SSE stream forwards to the UI.
  void (async (): Promise<void> => {
    try {
      await executeWorkflow(
        workflowDeps(),
        webAdapter,
        platformConversationId,
        cwd,
        workflow,
        run.user_message,
        workerConv.id,
        run.codebase_id ?? undefined,
        undefined,
        undefined,
        undefined,
        preCreatedRun
      );
    } catch (err) {
      log.error(
        { err: err as Error, new_run_id: preCreatedRun.id },
        'mission.replay.execute_threw'
      );
    }
  })();

  return {
    ok: true,
    result: {
      new_run_id: preCreatedRun.id,
      new_conversation_id: workerConv.id,
      workflow_name: run.workflow_name,
      drift,
    },
  };
}

let cachedDeps: ReturnType<typeof createWorkflowDeps> | null = null;
function workflowDeps(): ReturnType<typeof createWorkflowDeps> {
  if (!cachedDeps) cachedDeps = createWorkflowDeps();
  return cachedDeps;
}
