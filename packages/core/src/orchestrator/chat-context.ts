import type { IPlatformAdapter, Conversation, Codebase, AttachedFile } from '../types';
import { ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import { providerRegistry } from '@archon/providers';
import { getArchonWorkspacesPath } from '@archon/paths';
import { getDefaultRemote, syncWorkspace, toBranchName, toRepoPath } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import { discoverWorkflowsWithConfig, liveSourceRoots } from '@archon/workflows/workflow-discovery';
import type { WorkflowWithSource, WorkflowLoadError } from '@archon/workflows/schemas/workflow';
import { resolveWorkflowSourceRoot } from '../utils/workflow-source-root';
import { loadConfig, loadRepoConfig } from '../config/config-loader';
import type { MergedConfig } from '../config/config-types';
import { getLog } from './agent-log';

/** Copy parent conversation's project context to child thread if missing */
export async function inheritThreadContext(
  platform: IPlatformAdapter,
  conversation: Conversation,
  parentConversationId: string | undefined,
  conversationId: string
): Promise<Conversation> {
  if (!parentConversationId || conversation.codebase_id) return conversation;

  const parentConversation = await db.getConversationByPlatformId(
    platform.getPlatformType(),
    parentConversationId
  );
  if (!parentConversation?.codebase_id) return conversation;

  try {
    await db.updateConversation(conversation.id, {
      codebase_id: parentConversation.codebase_id,
      cwd: parentConversation.cwd,
    });
    const refreshed = await db.getOrCreateConversation(platform.getPlatformType(), conversationId);
    getLog().debug({ conversationId, parentConversationId }, 'thread_context_inherited');
    return refreshed;
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      getLog().warn({ conversationId: conversation.id }, 'thread_inheritance_failed');
      return conversation;
    }
    throw err;
  }
}

interface DiscoverResult {
  workflows: WorkflowWithSource[];
  errors: readonly WorkflowLoadError[];
  syncResult?: WorkspaceSyncResult;
  syncError?: string;
  config?: MergedConfig;
  codebase?: Codebase | null;
  /** Remote name used for the workspace sync (undefined when no sync ran). */
  remote?: string;
}

/** Discover global + repo-specific workflows, merge by name (repo overrides global) */
export async function discoverAllWorkflows(conversation: Conversation): Promise<DiscoverResult> {
  let workflows: WorkflowWithSource[] = [];
  const allErrors: WorkflowLoadError[] = [];
  let syncResult: WorkspaceSyncResult | undefined;
  let syncError: string | undefined;
  let config: MergedConfig | undefined;
  let codebase: Codebase | null | undefined;
  let remote: string | undefined;

  try {
    // Home-scoped workflows at ~/.archon/workflows/ are discovered automatically
    // by discoverWorkflowsWithConfig — no option needed.
    const result = await discoverWorkflowsWithConfig(
      getArchonWorkspacesPath(),
      loadConfig,
      providerRegistry
    );
    workflows = [...result.workflows];
    allErrors.push(...result.errors);
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, errorType: err.constructor.name }, 'global_workflow_discovery_failed');
  }

  if (conversation.codebase_id) {
    try {
      codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    } catch (error) {
      getLog().warn({ err: error as Error }, 'repo_workflow_discovery_failed');
    }
  }
  if (codebase) {
    // Sync canonical source with remote before the AI reads codebase state.
    // This path must remain non-destructive: users and agents can write to source/.
    // Non-fatal: if fetch fails (network, no remote), proceed with local state.
    // Folder projects leave git synchronization to the user and agent.
    if (codebase.kind === 'folder') {
      getLog().debug(
        { codebaseId: codebase.id, path: codebase.default_cwd },
        'workspace.sync_skipped_folder_project'
      );
    } else {
      try {
        // Resolve the git remote: explicit repo config wins, otherwise
        // auto-detect ('origin' if present, else the sole remote).
        const repoPath = toRepoPath(codebase.default_cwd);
        const repoConf = await loadRepoConfig(codebase.default_cwd);
        remote =
          repoConf.worktree?.remote?.trim() || (await getDefaultRemote(repoPath)) || undefined;
        syncResult = await syncWorkspace(
          repoPath,
          codebase.default_branch ? toBranchName(codebase.default_branch) : undefined,
          { remote }
        );
        getLog().debug(
          {
            codebaseId: codebase.id,
            repoPath: codebase.default_cwd,
            remote,
            ...syncResult,
          },
          'workspace.sync_completed'
        );
      } catch (err) {
        const error = err as Error;
        syncError = error.message;
        getLog().warn({ err: error, codebaseId: codebase.id }, 'workspace.sync_failed');
      }
    }
    const workflowCwd = conversation.cwd ?? codebase.default_cwd;
    // Outside the discovery catch: a config that fails to load fails the turn,
    // as it does for a run start, instead of listing no repository workflows.
    const loadedConfig = await loadConfig(workflowCwd);
    config = loadedConfig;
    try {
      // Read workflows from the authoring repo rather than copying its `.archon` into
      // this worktree first. Config still comes from `workflowCwd` — settings belong to
      // the workspace being acted on.
      const workflowSourceRoot = await resolveWorkflowSourceRoot(workflowCwd);
      const repoResult = await discoverWorkflowsWithConfig(
        workflowCwd,
        () => Promise.resolve(loadedConfig),
        providerRegistry,
        workflowSourceRoot === undefined ? undefined : liveSourceRoots(workflowSourceRoot)
      );
      const workflowMap = new Map(workflows.map(w => [w.workflow.name, w]));
      for (const rw of repoResult.workflows) {
        workflowMap.set(rw.workflow.name, rw);
      }
      workflows = Array.from(workflowMap.values());
      allErrors.push(...repoResult.errors);
    } catch (error) {
      getLog().warn({ err: error as Error }, 'repo_workflow_discovery_failed');
    }
  }

  return { workflows, errors: allErrors, syncResult, syncError, config, codebase, remote };
}

/** Build the user-facing prompt with message and optional contexts */
export function buildFullPrompt(
  message: string,
  issueContext: string | undefined,
  threadContext: string | undefined,
  attachedFiles?: AttachedFile[],
  workflowContext?: string,
  pausedGateContext?: string
): string {
  const contextSuffix = issueContext ? '\n\n---\n\n## Additional Context\n\n' + issueContext : '';

  const fileSuffix =
    attachedFiles && attachedFiles.length > 0
      ? '\n\n---\n\n## Attached Files\n\nThe user has uploaded the following files. Use your file reading tools (Read, View) to access them:\n\n' +
        attachedFiles
          .map(f => `- ${f.name} (${f.mimeType}, ${String(f.size)} bytes): ${f.path}`)
          .join('\n')
      : '';

  const workflowContextSuffix = workflowContext ? '\n\n---\n\n' + workflowContext : '';
  // Placed LAST of the context blocks, immediately before the user's message —
  // the gate is the thing the message is most likely answering (#2565).
  const gateSuffix = pausedGateContext ? '\n\n---\n\n' + pausedGateContext : '';

  if (threadContext) {
    return (
      '## Thread Context (previous messages)\n\n' +
      threadContext +
      workflowContextSuffix +
      gateSuffix +
      '\n\n---\n\n## Current Request\n\n' +
      message +
      contextSuffix +
      fileSuffix
    );
  }

  return (
    workflowContextSuffix +
    gateSuffix +
    '\n\n---\n\n## User Message\n\n' +
    message +
    contextSuffix +
    fileSuffix
  );
}
