/**
 * Orchestrator Agent - Main entry point for AI-powered message routing
 *
 * Single entry point for all platforms:
 * - Knows all registered projects and workflows upfront
 * - Can answer directly or invoke workflows
 * - Does NOT require a project to be selected before starting a conversation
 */
import { existsSync } from 'fs';
import { createLogger } from '@archon/paths';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  AttachedFile,
} from '../types';
import type { SendQueryOptions } from '@archon/providers/types';
import { ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '@archon/workflows/utils/tool-formatter';
import { classifyAndFormatError } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { getAgentProvider, getProviderCapabilities } from '@archon/providers';
import { getArchonHome, getArchonWorkspacesPath } from '@archon/paths';
import { syncArchonToWorktree } from '../utils/worktree-sync';
import { syncWorkspace, toRepoPath } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow } from '@archon/workflows/router';
import { executeWorkflow } from '@archon/workflows/executor';
import type {
  WorkflowDefinition,
  WorkflowWithSource,
  WorkflowLoadError,
} from '@archon/workflows/schemas/workflow';
import { createWorkflowDeps } from '../workflows/store-adapter';
import { loadConfig } from '../config/config-loader';
import type { MergedConfig } from '../config/config-types';
import { generateAndSetTitle } from '../services/title-generator';
import { validateAndResolveIsolation, dispatchBackgroundWorkflow } from './orchestrator';
import { IsolationBlockedError } from '@archon/isolation';
import { buildOrchestratorPrompt, buildProjectScopedPrompt } from './prompt-builder';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import { getCodebaseEnvVars } from '../db/env-vars';
import type { ApprovalContext } from '@archon/workflows/schemas/workflow-run';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator-agent');
  return cachedLog;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max assistant text chunks to keep in batch mode (oldest are dropped) */
const MAX_BATCH_ASSISTANT_CHUNKS = 20;
/** Max total chunks (assistant + tool) to keep in batch mode */
const MAX_BATCH_TOTAL_CHUNKS = 200;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowInvocation {
  workflowName: string;
  projectName: string;
  remainingMessage: string;
  synthesizedPrompt?: string;
}

export interface ProjectRegistration {
  projectName: string;
  projectPath: string;
}

export interface OrchestratorCommands {
  workflowInvocation: WorkflowInvocation | null;
  projectRegistration: ProjectRegistration | null;
}

// ─── Command Parsing ────────────────────────────────────────────────────────

/**
 * Find a codebase by exact name or by last path segment (e.g., "repo" matches "owner/repo").
 * Case-insensitive. Used in both the parse phase and the dispatch phase.
 */
function findCodebaseByName(
  codebases: readonly Codebase[],
  projectName: string
): Codebase | undefined {
  const projectLower = projectName.toLowerCase();
  return codebases.find(c => {
    const nameLower = c.name.toLowerCase();
    return nameLower === projectLower || nameLower.endsWith(`/${projectLower}`);
  });
}

/**
 * Parse orchestrator commands from AI response text.
 * Scans for /invoke-workflow and /register-project patterns.
 */
export function parseOrchestratorCommands(
  response: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[]
): OrchestratorCommands {
  const result: OrchestratorCommands = {
    workflowInvocation: null,
    projectRegistration: null,
  };

  // Parse /invoke-workflow {name} --project {project-name}
  // Use (\S+) for project name to avoid capturing trailing text on the same line
  // (e.g., when AI appends tool call indicators or continues text after the command).
  // --project MUST appear before --prompt; this order is specified in the system prompt
  // template. Commands with --prompt before --project will not match.
  const invokePattern = /^\/invoke-workflow\s+(\S+)\s+--project[\s=]+(\S+)/m;
  const invokeMatch = invokePattern.exec(response);
  if (invokeMatch) {
    const workflowName = invokeMatch[1].trim();
    const projectName = invokeMatch[2].trim();

    // Validate workflow exists
    const workflow = findWorkflow(workflowName, [...workflows]);
    if (workflow) {
      // Validate project exists (case-insensitive, supports partial name matching)
      // e.g., "Archon" matches "coleam00/Archon"
      const matchedCodebase = findCodebaseByName(codebases, projectName);
      if (matchedCodebase) {
        // Extract message before the command
        const commandIndex = response.indexOf(invokeMatch[0]);
        const remainingMessage = response.slice(0, commandIndex).trim();

        // Extract optional --prompt "..." parameter (double or single quotes)
        const commandText = response.slice(commandIndex);
        const promptPattern = /--prompt\s+(?:"([^"]+)"|'([^']+)')/;
        const promptMatch = promptPattern.exec(commandText);
        const rawPrompt = (promptMatch?.[1] ?? promptMatch?.[2])?.trim();
        const synthesizedPrompt = rawPrompt || undefined;

        if (promptMatch && !synthesizedPrompt) {
          getLog().warn({ workflowName, projectName }, 'synthesized_prompt_empty_discarded');
        }

        result.workflowInvocation = {
          workflowName: workflow.name,
          projectName: matchedCodebase.name,
          remainingMessage,
          synthesizedPrompt,
        };
      }
    }
  }

  // Parse /register-project {name} {path}
  const registerPattern = /^\/register-project\s+(\S+)\s+(.+)$/m;
  const registerMatch = registerPattern.exec(response);
  if (registerMatch) {
    result.projectRegistration = {
      projectName: registerMatch[1].trim(),
      projectPath: registerMatch[2].trim(),
    };
  }

  return result;
}

// ─── Batch Mode Helpers ─────────────────────────────────────────────────────

/**
 * Filter emoji tool indicators from Claude Code SDK responses.
 * These prefixed sections (🔧, 💭, 📝, etc.) are useful for streaming UIs
 * but garble batch-mode text output on platforms like Slack/GitHub/CLI.
 */
function filterToolIndicators(assistantMessages: string[]): string {
  if (assistantMessages.length === 0) return '';

  const allMessages = assistantMessages.join('\n\n---\n\n');
  const sections = allMessages.split('\n\n');

  // Tool indicators from Claude Code SDK responses:
  // 🔧 (U+1F527) - tool usage, 💭 (U+1F4AD) - thinking, 📝 (U+1F4DD) - writing,
  // ✏️ (U+270F+FE0F) - editing, 🗑️ (U+1F5D1+FE0F) - deleting,
  // 📂 (U+1F4C2) - folder, 🔍 (U+1F50D) - search
  const toolIndicatorRegex =
    /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;
  const cleanSections = sections.filter(section => {
    const trimmed = section.trim();
    return !toolIndicatorRegex.test(trimmed);
  });

  const finalMessage = cleanSections.join('\n\n').trim();

  // If we filtered everything out, fall back to all messages joined
  return finalMessage || allMessages;
}

// ─── Workflow Dispatch ──────────────────────────────────────────────────────

/**
 * Dispatch a workflow after the orchestrator resolves a project.
 * Auto-attaches the project to the conversation, resolves isolation, and executes.
 *
 * TODO(#988): Move to operations/ once dispatchBackgroundWorkflow is extracted
 * from the orchestrator (currently coupled to SSE bridging infrastructure).
 */
async function dispatchOrchestratorWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  workflow: WorkflowDefinition,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  // Auto-attach project to conversation
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
  });

  // Validate and resolve isolation
  let cwd: string;
  try {
    const result = await validateAndResolveIsolation(
      { ...conversation, codebase_id: codebase.id },
      codebase,
      platform,
      conversationId,
      isolationHints
    );
    cwd = result.cwd;
  } catch (error) {
    if (error instanceof IsolationBlockedError) {
      getLog().warn(
        {
          reason: error.reason,
          conversationId,
          codebaseId: codebase.id,
          workflowName: workflow.name,
        },
        'isolation_blocked'
      );
      return;
    }
    throw error;
  }

  // Dispatch workflow
  if (platform.getPlatformType() === 'web') {
    // Check for a resumable run from a prior dispatch (e.g. approved approval gate).
    // A new background dispatch would create a new worker conversation and never find
    // the prior run's worktree. Execute in foreground to reuse the original working path.
    const resumableRun = await workflowDb.findResumableRunByParentConversation(
      workflow.name,
      conversation.id
    );
    if (resumableRun?.working_path) {
      getLog().info(
        {
          workflowName: workflow.name,
          resumableRunId: resumableRun.id,
          workingPath: resumableRun.working_path,
        },
        'orchestrator.foreground_resume_detected'
      );
      await executeWorkflow(
        createWorkflowDeps(),
        platform,
        conversationId,
        resumableRun.working_path,
        workflow,
        userMessage,
        conversation.id,
        codebase.id
      );
    } else if (workflow.interactive) {
      // Interactive workflows run in foreground so output stays in the user's conversation
      await executeWorkflow(
        createWorkflowDeps(),
        platform,
        conversationId,
        cwd,
        workflow,
        userMessage,
        conversation.id,
        codebase.id
      );
    } else {
      await dispatchBackgroundWorkflow(
        {
          platform,
          conversationId,
          cwd,
          originalMessage: userMessage,
          conversationDbId: conversation.id,
          codebaseId: codebase.id,
          availableWorkflows: [workflow],
          isolationHints,
        },
        workflow
      );
    }
  } else {
    await executeWorkflow(
      createWorkflowDeps(),
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversation.id,
      codebase.id
    );
  }
}

// ─── Session Helpers ────────────────────────────────────────────────────────

async function tryPersistSessionId(sessionId: string, assistantSessionId: string): Promise<void> {
  try {
    await sessionDb.updateSession(sessionId, assistantSessionId);
  } catch (error) {
    getLog().error(
      { err: error as Error, sessionId, newSessionId: assistantSessionId },
      'session_id_persist_failed'
    );
  }
}

// ─── Extracted Helpers ──────────────────────────────────────────────────────

/** Copy parent conversation's project context to child thread if missing */
async function inheritThreadContext(
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
}

/** Discover global + repo-specific workflows, merge by name (repo overrides global) */
async function discoverAllWorkflows(conversation: Conversation): Promise<DiscoverResult> {
  let workflows: WorkflowWithSource[] = [];
  const allErrors: WorkflowLoadError[] = [];
  let syncResult: WorkspaceSyncResult | undefined;
  let syncError: string | undefined;
  let config: MergedConfig | undefined;

  try {
    const result = await discoverWorkflowsWithConfig(getArchonWorkspacesPath(), loadConfig, {
      globalSearchPath: getArchonHome(),
    });
    workflows = [...result.workflows];
    allErrors.push(...result.errors);
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, errorType: err.constructor.name }, 'global_workflow_discovery_failed');
  }

  if (conversation.codebase_id) {
    try {
      const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
      if (codebase) {
        // Sync canonical source with remote before the AI reads codebase state.
        // Only hard-reset for Archon-managed clones (under ~/.archon/workspaces/).
        // Locally-registered repos get fetch-only to avoid destroying uncommitted work.
        // Non-fatal: if fetch fails (network, no remote), proceed with local state.
        try {
          const isManagedClone = codebase.default_cwd
            .replace(/\\/g, '/')
            .startsWith(getArchonWorkspacesPath().replace(/\\/g, '/'));
          syncResult = await syncWorkspace(toRepoPath(codebase.default_cwd), undefined, {
            resetAfterFetch: isManagedClone,
          });
          getLog().debug(
            {
              codebaseId: codebase.id,
              repoPath: codebase.default_cwd,
              isManagedClone,
              ...syncResult,
            },
            'workspace.sync_completed'
          );
        } catch (err) {
          const error = err as Error;
          syncError = error.message;
          getLog().warn({ err: error, codebaseId: codebase.id }, 'workspace.sync_failed');
        }
        const workflowCwd = conversation.cwd ?? codebase.default_cwd;
        await syncArchonToWorktree(workflowCwd);
        // Load config once for this codebase path; reuse below to avoid a second disk read
        const loadedConfig = await loadConfig(workflowCwd);
        config = loadedConfig;
        const repoResult = await discoverWorkflowsWithConfig(workflowCwd, () =>
          Promise.resolve(loadedConfig)
        );
        const workflowMap = new Map(workflows.map(w => [w.workflow.name, w]));
        for (const rw of repoResult.workflows) {
          workflowMap.set(rw.workflow.name, rw);
        }
        workflows = Array.from(workflowMap.values());
        allErrors.push(...repoResult.errors);
      }
    } catch (error) {
      getLog().warn({ err: error as Error }, 'repo_workflow_discovery_failed');
    }
  }

  return { workflows, errors: allErrors, syncResult, syncError, config };
}

/** Build the full prompt with system prompt, user message, and optional contexts */
function buildFullPrompt(
  conversation: Conversation,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  message: string,
  issueContext: string | undefined,
  threadContext: string | undefined,
  attachedFiles?: AttachedFile[]
): string {
  const scopedCodebase = conversation.codebase_id
    ? codebases.find(c => c.id === conversation.codebase_id)
    : undefined;

  const systemPrompt = scopedCodebase
    ? buildProjectScopedPrompt(scopedCodebase, codebases, workflows)
    : buildOrchestratorPrompt(codebases, workflows);

  const contextSuffix = issueContext ? '\n\n---\n\n## Additional Context\n\n' + issueContext : '';

  const fileSuffix =
    attachedFiles && attachedFiles.length > 0
      ? '\n\n---\n\n## Attached Files\n\nThe user has uploaded the following files. Use your file reading tools (Read, View) to access them:\n\n' +
        attachedFiles
          .map(f => `- ${f.name} (${f.mimeType}, ${String(f.size)} bytes): ${f.path}`)
          .join('\n')
      : '';

  if (threadContext) {
    return (
      systemPrompt +
      '\n\n---\n\n## Thread Context (previous messages)\n\n' +
      threadContext +
      '\n\n---\n\n## Current Request\n\n' +
      message +
      contextSuffix +
      fileSuffix
    );
  }

  return systemPrompt + '\n\n---\n\n## User Message\n\n' + message + contextSuffix + fileSuffix;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Handle a message through the orchestrator agent.
 * Single entry point for all platforms — routes slash commands deterministically,
 * and routes everything else through the AI orchestrator which knows all projects
 * and workflows upfront.
 */
export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: HandleMessageContext
): Promise<void> {
  const { issueContext, threadContext, parentConversationId, isolationHints, attachedFiles } =
    context ?? {};
  try {
    getLog().debug({ conversationId }, 'orchestrator_message_received');

    // 1. Get/create conversation and inherit thread context
    let conversation = await db.getOrCreateConversation(
      platform.getPlatformType(),
      conversationId,
      undefined,
      parentConversationId
    );
    conversation = await inheritThreadContext(
      platform,
      conversation,
      parentConversationId,
      conversationId
    );

    // 1c. Auto-generate title for untitled conversations (fire-and-forget)
    if (!conversation.title && !message.startsWith('/')) {
      void generateAndSetTitle(
        conversation.id,
        message,
        conversation.ai_assistant_type,
        getArchonWorkspacesPath()
      );
    }

    // Natural-language approval routing — if a workflow is paused in this
    // conversation, treat any non-slash message as the approval response.
    if (!message.startsWith('/')) {
      const pausedRun = await workflowDb.getPausedWorkflowRun(conversation.id);
      if (pausedRun) {
        const approvalRaw = pausedRun.metadata.approval;
        const hasValidApproval =
          approvalRaw != null &&
          typeof approvalRaw === 'object' &&
          'nodeId' in approvalRaw &&
          typeof (approvalRaw as Record<string, unknown>).nodeId === 'string';

        if (!hasValidApproval) {
          // Paused run exists but approval context is missing or corrupt —
          // tell the user so they can use explicit commands instead.
          await platform.sendMessage(
            conversationId,
            'A workflow is paused but its approval context is missing. ' +
              `Use \`/workflow approve ${pausedRun.id}\` or \`/workflow reject ${pausedRun.id}\`.`
          );
          return;
        }

        const approval = approvalRaw as ApprovalContext;
        getLog().info(
          {
            conversationId,
            workflowRunId: pausedRun.id,
            nodeId: approval.nodeId,
            workflowName: pausedRun.workflow_name,
          },
          'orchestrator.natural_language_approval_started'
        );

        try {
          // Write approval events — for interactive loops, do NOT write node_completed
          // (the executor writes it when the AI emits the completion signal on actual exit).
          if (approval.type !== 'interactive_loop') {
            const nodeOutput = approval.captureResponse === true ? message : '';
            await workflowEventDb.createWorkflowEvent({
              workflow_run_id: pausedRun.id,
              event_type: 'node_completed',
              step_name: approval.nodeId,
              data: { node_output: nodeOutput, approval_decision: 'approved' },
            });
          }
          await workflowEventDb.createWorkflowEvent({
            workflow_run_id: pausedRun.id,
            event_type: 'approval_received',
            step_name: approval.nodeId,
            data: { decision: 'approved', comment: message },
          });
          // For interactive loops, store user input; for standard approvals, mark as approved
          // and clear any rejection state.
          const metadataUpdate: Record<string, unknown> =
            approval.type === 'interactive_loop'
              ? { loop_user_input: message }
              : { approval_response: 'approved', rejection_reason: '', rejection_count: 0 };
          await workflowDb.updateWorkflowRun(pausedRun.id, {
            status: 'failed',
            metadata: metadataUpdate,
          });

          // Discover workflow and resume
          const { workflows: discoveredWorkflows } = await discoverAllWorkflows(conversation);
          const allWorkflows: WorkflowDefinition[] = discoveredWorkflows.map(w => w.workflow);
          const workflow = findWorkflow(pausedRun.workflow_name, allWorkflows);
          if (!workflow) {
            await platform.sendMessage(
              conversationId,
              `Approved, but workflow \`${pausedRun.workflow_name}\` not found. ` +
                'The approval was recorded — use `/workflow list` to check available workflows.'
            );
            return;
          }
          const codebase = conversation.codebase_id
            ? await codebaseDb.getCodebase(conversation.codebase_id)
            : null;
          if (!codebase) {
            await platform.sendMessage(
              conversationId,
              'Approved, but no project is attached to this conversation. ' +
                'The approval was recorded — re-run the workflow to resume.'
            );
            return;
          }
          await platform.sendMessage(conversationId, `▶️ Resuming **${workflow.name}**...`);
          await dispatchOrchestratorWorkflow(
            platform,
            conversationId,
            conversation,
            codebase,
            workflow,
            pausedRun.user_message,
            isolationHints
          );
          getLog().info(
            { conversationId, workflowRunId: pausedRun.id, workflowName: pausedRun.workflow_name },
            'orchestrator.natural_language_approval_completed'
          );
        } catch (error) {
          getLog().error(
            { err: error as Error, workflowRunId: pausedRun.id, conversationId },
            'orchestrator.natural_language_approval_failed'
          );
          await platform.sendMessage(
            conversationId,
            `Approval failed: ${(error as Error).message}. ` +
              `Try again or use \`/workflow approve ${pausedRun.id}\` explicitly.`
          );
        }
        return;
      }
    }

    // 2. Check for deterministic commands
    if (message.startsWith('/')) {
      const { command } = commandHandler.parseCommand(message);
      const deterministicCommands = [
        'help',
        'status',
        'reset',
        'workflow',
        'register-project',
        'update-project',
        'remove-project',
        'commands',
        'init',
        'worktree',
      ];

      if (deterministicCommands.includes(command)) {
        if (command === 'register-project') {
          getLog().debug({ command, conversationId }, 'deterministic_command');
          const result = await handleRegisterProject(message, platform, conversationId);
          await platform.sendMessage(conversationId, result);
          return;
        }

        if (command === 'update-project') {
          getLog().debug({ command, conversationId }, 'deterministic_command');
          const result = await handleUpdateProject(message);
          await platform.sendMessage(conversationId, result);
          return;
        }

        if (command === 'remove-project') {
          getLog().debug({ command, conversationId }, 'deterministic_command');
          const result = await handleRemoveProject(message);
          await platform.sendMessage(conversationId, result);
          return;
        }

        getLog().debug({ command, conversationId }, 'deterministic_command');
        const result = await commandHandler.handleCommand(conversation, message);
        await platform.sendMessage(conversationId, result.message);

        if (result.workflow) {
          await handleWorkflowRunCommand(
            platform,
            conversationId,
            conversation,
            result.workflow.definition,
            result.workflow.args ?? message,
            isolationHints
          );
        }
        return;
      }
    }

    // 3. Load codebases, discover workflows, build prompt
    const codebases = await codebaseDb.listCodebases();
    const {
      workflows: workflowsWithSource,
      errors: workflowErrors,
      syncResult,
      syncError,
      config: discoveredConfig,
    } = await discoverAllWorkflows(conversation);
    const workflows: readonly WorkflowDefinition[] = workflowsWithSource.map(ws => ws.workflow);
    if (workflowErrors.length > 0) {
      getLog().warn(
        { errorCount: workflowErrors.length, errors: workflowErrors },
        'workflow.discovery_errors_present'
      );
    }

    // Emit workspace sync status only when something noteworthy happened
    // (HEAD moved or sync failed). Skip the "up to date" case to avoid noise.
    if (syncError && platform.sendStructuredEvent) {
      await platform.sendStructuredEvent(conversationId, {
        type: 'system',
        content: 'Sync failed \u2014 using local state',
      });
    } else if (syncResult?.updated && platform.sendStructuredEvent) {
      await platform.sendStructuredEvent(conversationId, {
        type: 'system',
        content: `Synced with origin/${syncResult.branch} \u2014 updated ${syncResult.previousHead} \u2192 ${syncResult.newHead}`,
      });
    }

    const fullPrompt = buildFullPrompt(
      conversation,
      codebases,
      workflows,
      message,
      issueContext,
      threadContext,
      attachedFiles
    );
    const cwd = getArchonWorkspacesPath();

    // 4. Update activity and get/create session
    await db.touchConversation(conversation.id);
    let session = await sessionDb.getActiveSession(conversation.id);
    if (!session) {
      session = await sessionDb.transitionSession(conversation.id, 'first-message', {
        ai_assistant_type: conversation.ai_assistant_type,
      });
    }

    // 5. Send to AI provider
    const aiClient = getAgentProvider(conversation.ai_assistant_type);
    getLog().debug({ assistantType: conversation.ai_assistant_type }, 'sending_to_ai');

    // Reuse the config already loaded during workflow discovery (avoids a second disk read).
    // Fall back to loadConfig only when no codebase is scoped (discoveredConfig is undefined).
    const config = discoveredConfig ?? (await loadConfig());
    const providerKey = conversation.ai_assistant_type;
    let dbEnvVars: Record<string, string> = {};
    if (conversation.codebase_id) {
      try {
        dbEnvVars = await getCodebaseEnvVars(conversation.codebase_id);
      } catch (error) {
        getLog().warn(
          { err: error as Error, codebaseId: conversation.codebase_id },
          'codebase_env_vars_load_failed'
        );
      }
    }
    const effectiveEnv = { ...(config.envVars ?? {}), ...dbEnvVars };

    // Warn if provider doesn't support env injection but env vars are configured
    if (Object.keys(effectiveEnv).length > 0) {
      const providerCaps = getProviderCapabilities(providerKey);
      if (!providerCaps.envInjection) {
        getLog().warn(
          { provider: providerKey, envVarCount: Object.keys(effectiveEnv).length },
          'orchestrator.unsupported_env_injection'
        );
      }
    }

    const requestOptions: SendQueryOptions = {
      assistantConfig: config.assistants[providerKey] ?? {},
      env: Object.keys(effectiveEnv).length > 0 ? effectiveEnv : undefined,
    };

    const mode = platform.getStreamingMode();
    if (mode === 'stream') {
      await handleStreamMode(
        platform,
        conversationId,
        message,
        codebases,
        workflows,
        aiClient,
        fullPrompt,
        cwd,
        session,
        isolationHints,
        conversation,
        issueContext,
        requestOptions
      );
    } else {
      await handleBatchMode(
        platform,
        conversationId,
        message,
        codebases,
        workflows,
        aiClient,
        fullPrompt,
        cwd,
        session,
        isolationHints,
        conversation,
        issueContext,
        requestOptions
      );
    }

    getLog().debug({ conversationId }, 'orchestrator_message_completed');
  } catch (error) {
    const err = toError(error);
    getLog().error({ err, conversationId }, 'orchestrator_message_failed');
    const userMessage = classifyAndFormatError(err);
    try {
      await platform.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: toError(sendError), conversationId }, 'error_notification_failed');
    }
  }
}

// ─── Streaming Mode ─────────────────────────────────────────────────────────

/**
 * Stream mode: send text chunks immediately for real-time UX (web, Telegram stream).
 * If an orchestrator command is detected, retract streamed text and dispatch.
 */
async function handleStreamMode(
  platform: IPlatformAdapter,
  conversationId: string,
  originalMessage: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  aiClient: ReturnType<typeof getAgentProvider>,
  fullPrompt: string,
  cwd: string,
  session: { id: string; assistant_session_id: string | null },
  isolationHints: HandleMessageContext['isolationHints'],
  conversation: Conversation,
  issueContext?: string,
  requestOptions?: SendQueryOptions
): Promise<void> {
  const allMessages: string[] = [];
  let newSessionId: string | undefined;
  let commandDetected = false;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    requestOptions
  )) {
    if (msg.type === 'assistant' && msg.content) {
      if (!commandDetected) {
        allMessages.push(msg.content);
        const accumulated = allMessages.join('');
        // Check for orchestrator commands BEFORE streaming to frontend.
        // If detected, suppress this chunk and all future chunks — the full
        // response will be parsed post-loop and the command dispatched there.
        if (
          /^\/invoke-workflow\s/m.test(accumulated) ||
          /^\/register-project\s/m.test(accumulated)
        ) {
          commandDetected = true;
        } else {
          await platform.sendMessage(conversationId, msg.content);
        }
      }
    } else if (msg.type === 'tool' && msg.toolName) {
      if (!commandDetected) {
        const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
        await platform.sendMessage(conversationId, toolMessage, {
          category: 'tool_call_formatted',
        });
        if (platform.sendStructuredEvent) {
          await platform.sendStructuredEvent(conversationId, msg);
        }
      }
    } else if (msg.type === 'tool_result' && msg.toolName) {
      if (!commandDetected && platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    } else if (msg.type === 'result' && msg.sessionId) {
      newSessionId = msg.sessionId;
      if (!commandDetected && platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (allMessages.length === 0) {
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  const fullResponse = allMessages.join('');
  const commands = parseOrchestratorCommands(fullResponse, codebases, workflows);

  if (commands.workflowInvocation) {
    // Retract streamed text — workflow dispatch replaces it
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleWorkflowInvocationResult(
      platform,
      conversationId,
      conversation,
      codebases,
      workflows,
      commands.workflowInvocation,
      originalMessage,
      isolationHints,
      issueContext
    );
    return;
  }

  if (commands.projectRegistration) {
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleProjectRegistrationResult(
      platform,
      conversationId,
      fullResponse,
      commands.projectRegistration
    );
    return;
  }

  // Text was already streamed — nothing more to send
}

// ─── Batch Mode ─────────────────────────────────────────────────────────────

/**
 * Batch mode: accumulate all chunks, filter tool indicators, send final clean summary.
 * Used by Slack, GitHub, Discord (batch), and CLI.
 */
async function handleBatchMode(
  platform: IPlatformAdapter,
  conversationId: string,
  originalMessage: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  aiClient: ReturnType<typeof getAgentProvider>,
  fullPrompt: string,
  cwd: string,
  session: { id: string; assistant_session_id: string | null },
  isolationHints: HandleMessageContext['isolationHints'],
  conversation: Conversation,
  issueContext?: string,
  requestOptions?: SendQueryOptions
): Promise<void> {
  const allChunks: { type: string; content: string }[] = [];
  const assistantMessages: string[] = [];
  let assistantChunksTruncated = false;
  let totalChunksTruncated = false;
  let newSessionId: string | undefined;
  let commandDetected = false;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    requestOptions
  )) {
    if (msg.type === 'assistant' && msg.content) {
      if (!commandDetected) {
        assistantMessages.push(msg.content);
        allChunks.push({ type: 'assistant', content: msg.content });

        if (assistantMessages.length > MAX_BATCH_ASSISTANT_CHUNKS) {
          assistantMessages.shift();
          assistantChunksTruncated = true;
        }
        const accumulated = assistantMessages.join('');
        if (
          /^\/invoke-workflow\s/m.test(accumulated) ||
          /^\/register-project\s/m.test(accumulated)
        ) {
          commandDetected = true;
        }
      }
    } else if (msg.type === 'tool' && msg.toolName) {
      if (!commandDetected) {
        const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
        allChunks.push({ type: 'tool', content: toolMessage });
        getLog().debug({ toolName: msg.toolName }, 'tool_call');
      }
    } else if (msg.type === 'result' && msg.sessionId) {
      newSessionId = msg.sessionId;
    }

    if (!commandDetected && allChunks.length > MAX_BATCH_TOTAL_CHUNKS) {
      allChunks.shift();
      totalChunksTruncated = true;
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (assistantChunksTruncated || totalChunksTruncated) {
    getLog().warn(
      {
        assistantChunksTruncated,
        totalChunksTruncated,
        maxAssistantChunks: MAX_BATCH_ASSISTANT_CHUNKS,
        maxTotalChunks: MAX_BATCH_TOTAL_CHUNKS,
      },
      'batch_mode_chunks_truncated'
    );
  }

  getLog().debug(
    { totalChunks: allChunks.length, assistantMessages: assistantMessages.length },
    'batch_mode_chunks_received'
  );

  // Filter tool indicators and build final message
  const finalMessage = filterToolIndicators(assistantMessages);

  if (!finalMessage) {
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  // Parse orchestrator commands from filtered response
  const commands = parseOrchestratorCommands(finalMessage, codebases, workflows);

  if (commands.workflowInvocation) {
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleWorkflowInvocationResult(
      platform,
      conversationId,
      conversation,
      codebases,
      workflows,
      commands.workflowInvocation,
      originalMessage,
      isolationHints,
      issueContext
    );
    return;
  }

  if (commands.projectRegistration) {
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleProjectRegistrationResult(
      platform,
      conversationId,
      finalMessage,
      commands.projectRegistration
    );
    return;
  }

  // No orchestrator commands — send the clean response
  getLog().debug({ messageLength: finalMessage.length }, 'sending_final_message');
  await platform.sendMessage(conversationId, finalMessage);
}

// ─── Orchestrator Command Handlers ──────────────────────────────────────────

/**
 * Handle a parsed /invoke-workflow command from AI response.
 */
async function handleWorkflowInvocationResult(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  invocation: WorkflowInvocation,
  originalMessage: string,
  isolationHints: HandleMessageContext['isolationHints'],
  issueContext?: string
): Promise<void> {
  const { workflowName, projectName, remainingMessage } = invocation;

  // Send explanation text before dispatching
  if (remainingMessage) {
    await platform.sendMessage(conversationId, remainingMessage);
  }

  // Find the codebase and workflow (supports partial name matching)
  const codebase = findCodebaseByName(codebases, projectName);
  const workflow = findWorkflow(workflowName, [...workflows]);

  if (codebase && workflow) {
    const workflowPrompt = invocation.synthesizedPrompt ?? originalMessage;
    getLog().debug(
      {
        source: invocation.synthesizedPrompt ? 'synthesized' : 'original',
        promptLength: workflowPrompt.length,
        workflowName,
        hasIssueContext: !!issueContext,
        issueContextLength: issueContext?.length ?? 0,
      },
      'workflow_prompt_resolved'
    );
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      workflow,
      workflowPrompt,
      isolationHints
    );
    return;
  }

  // Fallback: send error about missing project or workflow
  if (!codebase) {
    const projectList = codebases.map(c => `- ${c.name}`).join('\n');
    await platform.sendMessage(
      conversationId,
      `I couldn't find a project matching "${projectName}". Here are your registered projects:\n${projectList || '(none)'}\n\nPlease specify which project you'd like to use.`
    );
  } else if (!workflow) {
    getLog().warn({ workflowName, projectName }, 'workflow_not_found_in_dispatch');
    await platform.sendMessage(
      conversationId,
      `Workflow \`${workflowName}\` is not available. Use \`/workflow list\` to see available workflows.`
    );
  }
}

/**
 * Handle a parsed /register-project command from AI response.
 */
async function handleProjectRegistrationResult(
  platform: IPlatformAdapter,
  conversationId: string,
  fullResponse: string,
  registration: ProjectRegistration
): Promise<void> {
  const { projectName, projectPath } = registration;

  // Send the AI text before the command
  const regIndex = fullResponse.indexOf('/register-project');
  const textBeforeReg = fullResponse.slice(0, regIndex).trim();
  if (textBeforeReg) {
    await platform.sendMessage(conversationId, textBeforeReg);
  }

  // Register the project
  const regResult = await handleRegisterProject(
    `/register-project ${projectName} ${projectPath}`,
    platform,
    conversationId
  );
  await platform.sendMessage(conversationId, regResult);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Handle /register-project command.
 * Creates a codebase DB entry for a cloned project.
 */
async function handleRegisterProject(
  message: string,
  _platform: IPlatformAdapter,
  _conversationId: string
): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 2) {
    return 'Usage: /register-project <name> <path>';
  }

  const [projectName, ...pathParts] = args;
  const projectPath = pathParts.join(' ');

  // Validate path exists
  if (!existsSync(projectPath)) {
    return `Path does not exist: ${projectPath}`;
  }

  // Check if codebase already exists with this name
  const existing = await codebaseDb.listCodebases();
  const alreadyExists = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (alreadyExists) {
    return `Project "${projectName}" is already registered (path: ${alreadyExists.default_cwd}).`;
  }

  // Use config default provider instead of hardcoding 'claude'
  const config = await loadConfig();
  const codebase = await codebaseDb.createCodebase({
    name: projectName,
    default_cwd: projectPath,
    ai_assistant_type: config.assistant,
  });

  getLog().info(
    { name: projectName, path: projectPath, id: codebase.id },
    'project.register_completed'
  );
  return `Project "${projectName}" registered successfully!\nPath: ${projectPath}\nID: ${codebase.id}`;
}

/**
 * Handle /update-project command.
 * Updates the path for an existing registered project.
 */
async function handleUpdateProject(message: string): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 2) {
    return 'Usage: /update-project <name> <new-path>';
  }

  const [projectName, ...pathParts] = args;
  const newPath = pathParts.join(' ');

  // Validate path exists
  if (!existsSync(newPath)) {
    return `Path does not exist: ${newPath}`;
  }

  // Find existing codebase by name
  const existing = await codebaseDb.listCodebases();
  const codebase = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (!codebase) {
    return `Project "${projectName}" not found. Use /register-project to create it.`;
  }

  try {
    await codebaseDb.updateCodebase(codebase.id, { default_cwd: newPath });
  } catch {
    return `Project "${projectName}" could not be updated — it may have been removed.`;
  }
  getLog().info(
    { name: projectName, oldPath: codebase.default_cwd, newPath, id: codebase.id },
    'project.update_completed'
  );
  return `Project "${projectName}" updated.\nOld path: ${codebase.default_cwd}\nNew path: ${newPath}`;
}

/**
 * Handle /remove-project command.
 * Deletes a registered project from the database.
 */
async function handleRemoveProject(message: string): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 1) {
    return 'Usage: /remove-project <name>';
  }

  const projectName = args[0];

  // Find existing codebase by name
  const existing = await codebaseDb.listCodebases();
  const codebase = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (!codebase) {
    return `Project "${projectName}" not found.`;
  }

  await codebaseDb.deleteCodebase(codebase.id);
  getLog().info({ name: projectName, id: codebase.id }, 'project.remove_completed');
  return `Project "${projectName}" removed.\nPath was: ${codebase.default_cwd}`;
}

/**
 * Handle /workflow run command when project context may be missing.
 * Implements Edge Case E2 from the plan.
 */
async function handleWorkflowRunCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  workflow: WorkflowDefinition,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  // Check if conversation has a project
  if (conversation.codebase_id) {
    const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    if (!codebase) {
      await platform.sendMessage(conversationId, 'Codebase not found.');
      return;
    }

    // Route through dispatchOrchestratorWorkflow so validateAndResolveIsolation
    // always runs — ensures a worktree is created regardless of how the codebase
    // was registered (local path or GitHub URL clone).
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      workflow,
      userMessage,
      isolationHints
    );
    return;
  }

  // No project attached — apply E2 logic
  const codebases = await codebaseDb.listCodebases();

  if (codebases.length === 0) {
    await platform.sendMessage(
      conversationId,
      'No projects registered. Ask me to set up a project first.'
    );
    return;
  }

  if (codebases.length === 1) {
    // Auto-select the only project
    const codebase = codebases[0];
    const workflowCwd = conversation.cwd ?? codebase.default_cwd;
    try {
      await syncArchonToWorktree(workflowCwd);
    } catch (error) {
      getLog().debug(
        { err: error as Error, workflowCwd },
        'workflow_sync_before_validation_failed'
      );
    }

    let discovery;
    try {
      discovery = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, cwd: workflowCwd }, 'workflow_discovery_failed');
      await platform.sendMessage(
        conversationId,
        `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`
      );
      return;
    }

    const resolvedEntry =
      discovery.workflows.find(w => w.workflow.name === workflow.name) ??
      discovery.workflows.find(w => w.workflow.name.toLowerCase() === workflow.name.toLowerCase());
    const resolvedWorkflow = resolvedEntry?.workflow;

    if (!resolvedWorkflow) {
      const loadError = discovery.errors.find(
        e =>
          e.filename.replace(/\.ya?ml$/, '') === workflow.name ||
          e.filename === `${workflow.name}.yaml` ||
          e.filename === `${workflow.name}.yml`
      );
      if (loadError) {
        await platform.sendMessage(
          conversationId,
          `Workflow \`${workflow.name}\` failed to load: ${loadError.error}\n\nFix the YAML file and try again.`
        );
        return;
      }

      await platform.sendMessage(
        conversationId,
        `Workflow \`${workflow.name}\` not found.\n\nUse /workflow list to see available workflows.`
      );
      return;
    }

    await db.updateConversation(conversation.id, { codebase_id: codebase.id });
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      resolvedWorkflow,
      userMessage,
      isolationHints
    );
    return;
  }

  // Multiple projects — ask user to choose
  const projectList = codebases.map(c => `- ${c.name}`).join('\n');
  await platform.sendMessage(
    conversationId,
    `Which project should this workflow run on?\n\n${projectList}\n\nReply with the project name, or use: /workflow run ${workflow.name} --project <name> "${userMessage}"`
  );
}
