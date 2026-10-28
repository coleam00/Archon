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
import * as messageDb from '../db/messages';
import * as workflowDb from '../db/workflows';
import { formatPausedGateSection, formatWorkflowContextSection } from './prompt-builder';
import type { WorkflowResultContext } from './prompt-builder';
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
    ({ syncResult, syncError, remote } = await syncCodebaseBeforeDiscovery(codebase));
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

async function syncCodebaseBeforeDiscovery(
  codebase: Codebase
): Promise<Pick<DiscoverResult, 'syncResult' | 'syncError' | 'remote'>> {
  let syncResult: WorkspaceSyncResult | undefined;
  let syncError: string | undefined;
  let remote: string | undefined;
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
      remote = repoConf.worktree?.remote?.trim() || (await getDefaultRemote(repoPath)) || undefined;
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
  return { syncResult, syncError, remote };
}

/**
 * Emit workspace sync status only when something noteworthy happened
 * (HEAD moved or sync failed). Skip the "up to date" case to avoid noise.
 */
export async function reportWorkspaceSync(
  platform: IPlatformAdapter,
  conversationId: string,
  sync: Pick<DiscoverResult, 'syncResult' | 'syncError' | 'remote'>
): Promise<void> {
  const { syncResult, syncError, remote: syncRemote } = sync;
  if (syncError && platform.sendStructuredEvent) {
    await platform.sendStructuredEvent(conversationId, {
      type: 'system_status',
      content: 'Sync failed \u2014 using local state',
    });
  } else if (syncResult?.state === 'diverged' && platform.sendStructuredEvent) {
    await platform.sendStructuredEvent(conversationId, {
      type: 'system_status',
      content: `Local source/ has diverged from ${syncRemote ?? 'origin'}/${syncResult.branch} \u2014 manual merge or rebase needed`,
    });
  } else if (
    syncResult?.state === 'in_sync' &&
    syncResult.updated &&
    platform.sendStructuredEvent
  ) {
    await platform.sendStructuredEvent(conversationId, {
      type: 'system_status',
      content: `Fast-forwarded to ${syncRemote ?? 'origin'}/${syncResult.branch} \u2014 ${syncResult.previousHead} \u2192 ${syncResult.newHead}`,
    });
  }
}

/** Build workflow context for follow-up awareness. */
export async function loadWorkflowResultContext(
  conversation: Conversation,
  conversationId: string
): Promise<string | undefined> {
  let workflowContext: string | undefined;
  try {
    const recentResultMessages = await messageDb.getRecentWorkflowResultMessages(
      conversation.id,
      3
    );
    if (recentResultMessages.length > 0) {
      const workflowResults: WorkflowResultContext[] = recentResultMessages.map(msg => {
        let workflowName = 'unknown';
        let runId = 'unknown';
        try {
          const parsed = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
          const meta = parsed as {
            workflowResult?: { workflowName?: string; runId?: string };
          };
          workflowName = meta.workflowResult?.workflowName ?? 'unknown';
          runId = meta.workflowResult?.runId ?? 'unknown';
        } catch (metaErr) {
          // Malformed metadata — use defaults
          getLog().warn(
            { err: metaErr as Error, conversationId, messageId: msg.id },
            'orchestrator.workflow_result_metadata_parse_failed'
          );
        }
        return { workflowName, runId, summary: msg.content };
      });
      workflowContext = formatWorkflowContextSection(workflowResults);
    }
  } catch (error) {
    getLog().warn(
      { err: error as Error, conversationId },
      'orchestrator.workflow_context_fetch_failed'
    );
    // Non-critical — continue without context
  }
  return workflowContext;
}

// A human gate paused in this conversation is CONTEXT for the agent, not a
// branch in the router (#2565). Before #2565 any non-slash message here was
// recorded as an approval — including an objection — so an interpretation
// step never existed. Now the agent reads the gate alongside the message and
// resolves it (or doesn't) through the explicit approve/reject verbs it
// already has. Best-effort: getPausedWorkflowRun swallows DB errors and
// returns null, and a missing section only means the agent isn't told.
export async function loadPausedGateContext(
  platform: IPlatformAdapter,
  conversation: Conversation,
  conversationId: string
): Promise<string | undefined> {
  const pausedGateRun = await workflowDb.getPausedWorkflowRun(
    conversation.id,
    conversation.codebase_id ?? undefined
  );
  const pausedGateContext = pausedGateRun
    ? formatPausedGateSection({
        run: pausedGateRun,
        // Both resolution routes — the `manage_run` tool and the CLI-pointer
        // section — are gated on a scoped project; without one the section
        // must not instruct the agent to use verbs it does not have.
        agentCanResolve: conversation.codebase_id !== null,
        surface: platform,
      }) || undefined
    : undefined;
  if (pausedGateContext !== undefined) {
    getLog().info(
      {
        conversationId,
        workflowRunId: pausedGateRun?.id,
        workflowName: pausedGateRun?.workflow_name,
      },
      'orchestrator.paused_gate_context_injected'
    );
  }
  return pausedGateContext;
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
