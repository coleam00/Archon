/**
 * Orchestrator Agent - Main entry point for AI-powered message routing
 *
 * Single entry point for all platforms:
 * - Knows all registered projects and workflows upfront
 * - Can answer directly or invoke workflows
 * - Does NOT require a project to be selected before starting a conversation
 */
import { getRegistration, isRegisteredProvider } from '@archon/providers';
import { createSqlWorkflowOperations } from '../workflows/sql-host';
import type { RunActor } from '../operations/run-authorization';
import { existsSync } from 'fs';
import { captureChatTurn } from '@archon/paths';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  CommandResult,
} from '../types';
import type { ResultChunk, SendQueryOptions, TokenUsage } from '@archon/providers/types';
import {
  addResultUsage,
  sessionPreview,
  toolCallDisplayName,
  type ResultUsageTotal,
} from '@archon/provider-contract';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '@archon/workflows/utils/tool-formatter';
import { classifyAndFormatError, formatProviderFailure } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { quoteCommandArg } from '../utils/command-args';
import { getProviderCapabilities } from '@archon/providers';
import { getAgentProvider } from '../services/provider-admission';
import { buildManageRunTool } from './manage-run-tool';
import {
  buildInvokeWorkflowTool,
  buildRegisterProjectTool,
  findCodebaseByName,
  type ChatLaunch,
  type ProjectRegistration,
} from './chat-tools';
import { ensureArchonWorkspacesPath } from '@archon/paths';
import { findWorkflow } from '@archon/workflows/router';
import type { ResolvedWorkflow, WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import { isPerUserProviderKeysEnabled } from '../credentials/config';
import {
  ConnectedCredentialUnavailableError,
  type CredentialFailure,
} from '../credentials/unavailable-error';
import { loadConfig } from '../config/config-loader';
import { generateTitleForUser } from '../services/user-title-generator';
import {
  buildOrchestratorSystemAppend,
  buildRunManagementSection,
  formatPausedGateSection,
  formatWorkflowContextSection,
} from './prompt-builder';
import type { WorkflowResultContext } from './prompt-builder';
import { reportUnpushedWorkInSource } from './post-message-reminder';
import { getLog } from './agent-log';
import {
  NO_COMMANDS,
  hasCommandPrefix,
  isCommandFullyParsed,
  normalizeCommandText,
  parseOrchestratorCommands,
  type WorkflowInvocation,
} from './command-scan';
import {
  applyPresetToRequestOptions,
  resolveChatModelRequest,
  resolveModelRequest,
  resolveUserAiPrefsForChat,
  resolveUserProviderEnvForChat,
} from './chat-request';
import { buildFullPrompt, discoverAllWorkflows, inheritThreadContext } from './chat-context';
import {
  handleDetachProject,
  handleRegisterProject,
  handleRemoveProject,
  handleSetProject,
  handleUpdateProject,
  registerProject,
} from './project-commands';
import * as messageDb from '../db/messages';
import * as workflowDb from '../db/workflows';
import { getCodebaseEnvVars } from '../db/env-vars';
import {
  continueResolvedGateRun,
  dispatchOrchestratorWorkflow,
  handleWorkflowRunCommand,
  type ResolvedGate,
} from './workflow-dispatch';
import { buildAiProfile } from '@archon/workflows/model-validation';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max assistant text chunks to keep in batch mode (oldest are dropped) */
const MAX_BATCH_ASSISTANT_CHUNKS = 20;
/** Max total chunks (assistant + tool) to keep in batch mode */
const MAX_BATCH_TOTAL_CHUNKS = 200;

/**
 * Conversations (DB ids) already nudged about a tier fallback. Process-lifetime
 * memory is intentional and sufficient: the nudge is a discovery aid, not
 * state — a server restart re-nudging once per conversation is acceptable.
 */
const tierFallbackNudgedConversations = new Set<string>();

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

// ─── Session Helpers ────────────────────────────────────────────────────────

async function tryPersistSessionId(
  sessionId: string,
  assistantSessionId: string | null
): Promise<void> {
  try {
    await sessionDb.updateSession(sessionId, assistantSessionId);
  } catch (error) {
    getLog().error(
      {
        err: error as Error,
        sessionId,
        ...(assistantSessionId
          ? { persistedValuePreview: sessionPreview(assistantSessionId) }
          : {}),
      },
      'session_id_persist_failed'
    );
  }
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
  context: HandleMessageContext
): Promise<void> {
  const {
    issueContext,
    threadContext,
    parentConversationId,
    isolationHints,
    attachedFiles,
    actor,
    workflowName,
  } = context;
  const userId = actor.kind === 'user' ? actor.userId : undefined;
  // Anchor "is this a slash command" at the true start of the message —
  // leading whitespace (e.g. from a platform that doesn't pre-trim after
  // stripping a bot mention) must not let a command masquerade as a plain
  // AI turn. Mirrors the trim already done inside commandHandler.parseCommand.
  const trimmedMessage = message.trim();
  try {
    getLog().debug({ conversationId, userId }, 'orchestrator_message_received');

    const parsed =
      workflowName === undefined && trimmedMessage.startsWith('/')
        ? commandHandler.parseCommand(message)
        : undefined;
    if (parsed?.command === 'detach-project') {
      const reply = await handleDetachProject(
        platform,
        conversationId,
        parsed.args,
        parentConversationId
      );
      await platform.sendMessage(conversationId, reply);
      return;
    }

    // 1. Get/create conversation and inherit thread context.
    // userId is recorded on the conversation row only on first creation —
    // first-user-wins. The row's user_id is provenance plus a fallback for
    // execution identity; each turn's prefs/credentials resolve from the
    // SENDER when the adapter supplied one (see executionUserId below).
    // Per-message attribution happens on workflow_runs.
    let conversation = await db.getOrCreateConversation(
      platform.getPlatformType(),
      conversationId,
      undefined,
      parentConversationId,
      userId
    );
    conversation = await inheritThreadContext(
      platform,
      conversation,
      parentConversationId,
      conversationId
    );

    const deliverCommandResult = async (result: CommandResult): Promise<void> => {
      await platform.sendMessage(conversationId, result.message);
      if (!result.workflow) return;
      await handleWorkflowRunCommand(
        platform,
        conversationId,
        conversation,
        result.workflow,
        actor,
        isolationHints,
        {
          // Declared inputs (#2554) arrive on the request context, not in the
          // command text — the run route is the only caller that sets them.
          inputs: context.workflowInputs,
          modelOverrides: context.workflowModelOverrides,
          runConfig: context.workflowRunConfig,
          // Between-run continuation (#2747), same channel.
          adoptRunId: context.workflowAdoptRunId,
          supersedesRunId: context.workflowSupersedesRunId,
        }
      );
    };

    // 2. Check for deterministic commands
    if (workflowName !== undefined) {
      await deliverCommandResult(
        await commandHandler.startWorkflow(conversation, workflowName, message, false, platform)
      );
      return;
    }
    if (parsed) {
      const { command } = parsed;
      const deterministicCommands = [
        'help',
        'status',
        'reset',
        'workflow',
        'register-project',
        'update-project',
        'remove-project',
        'setproject',
        'commands',
        'init',
        'worktree',
      ];

      if (deterministicCommands.includes(command)) {
        if (command === 'register-project') {
          getLog().debug({ command, conversationId }, 'deterministic_command');
          const result = await handleRegisterProject(message);
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

        if (command === 'setproject') {
          getLog().debug({ command, conversationId }, 'deterministic_command');
          // Pass the full Conversation — handleSetProject updates by the DB
          // primary key (conversation.id, not the platform conversation id)
          // and needs the prior cwd/isolation state for the detach note.
          const result = await handleSetProject(message, conversation);
          await platform.sendMessage(conversationId, result);
          return;
        }

        getLog().debug({ command, conversationId }, 'deterministic_command');
        await deliverCommandResult(
          await commandHandler.handleCommand(conversation, message, actor, platform)
        );
        return;
      }
    }

    // A conversation's `cwd` override can outlive the directory it names. Every
    // path that tears a worktree down (`archon isolation cleanup`, the periodic
    // reaper, the isolation API route, a user's own `rm -rf`) marks the env row
    // destroyed without touching the conversation row, so `cwd` keeps pointing at
    // a path that is gone. Only the WORKFLOW path re-resolves isolation and
    // notices; a chat turn reads `cwd` verbatim and hands it to the provider,
    // which spawns its subprocess there and fails ENOENT — an error the Claude
    // SDK reports as a binary/libc mismatch, sending the operator after entirely
    // the wrong thing.
    //
    // Deliberately does NOT fall back to codebase.default_cwd: this conversation
    // asked to work in an isolated worktree, and quietly relocating the agent
    // into the live checkout would widen its write scope without consent. Runs
    // before the persist below so a refused turn leaves no `user` row without its
    // `assistant` pair, and after the deterministic-command early-returns above so
    // the commands that get out of this state keep working. Which of them applies
    // depends on `isolation_env_id` — see the message branch below.
    if (conversation.codebase_id !== null && conversation.cwd !== null) {
      if (!existsSync(conversation.cwd)) {
        getLog().warn(
          {
            conversationId: conversation.id,
            cwd: conversation.cwd,
            isolationEnvId: conversation.isolation_env_id,
          },
          'orchestrator.conversation_cwd_missing'
        );
        // The recovery advice branches on whether a worktree is still attached,
        // because `/worktree remove` hard-returns "This conversation is not using
        // a worktree." when `isolation_env_id` is null (command-handler.ts:428).
        // That state is reachable, not hypothetical: the `stale_cleaned` branch in
        // validateAndResolveIsolation (orchestrator.ts:204) clears
        // `isolation_env_id` and leaves `cwd` set, so a workflow run can strand a
        // conversation exactly here and the next chat turn would be told to run a
        // command that dead-ends. `/setproject` clears the cwd override and works
        // in both states, so it is the one suggestion that always applies.
        await platform.sendMessage(
          conversationId,
          `This conversation's working directory no longer exists:\n\`${conversation.cwd}\`\n\n` +
            (conversation.isolation_env_id !== null
              ? 'Its isolated worktree was removed after this conversation was bound to it. ' +
                'Run `/worktree remove` to detach and go back to the project root, or ' +
                '`/setproject <name>` to rebind this conversation to a project.'
              : 'This conversation is not bound to an isolated workspace, so there is nothing ' +
                'to detach. Run `/setproject <name>` to rebind this conversation to a project.')
        );
        return;
      }
    }

    // 3. Load codebases, discover workflows, build prompt
    //
    // The codebase load sits ABOVE the user-message persist so the missing-project
    // guard below can read `default_cwd` without paying a second query. It reads
    // `remote_agent_codebases` while the persist writes `remote_agent_messages`, so
    // the two are independent in both directions, and every OTHER consumer of
    // `codebases` runs far below (the guard just under this line is the one that
    // needed the hoist). Keep it here: moved back down, the guard would have to
    // refuse AFTER the user row is written, which is exactly the orphaned-row bug
    // this ordering exists to prevent.
    const codebases = await codebaseDb.listCodebases();

    // A registered project's directory can vanish under a long-lived conversation —
    // the clone deleted, the folder moved, the volume holding it unmounted.
    // Providers pass `cwd` straight to their subprocess, and `posix_spawn` reports
    // a missing WORKING DIRECTORY as ENOENT against the EXECUTABLE's path, so the
    // failure surfaces as "No such file or directory (os error 2)" on Codex or a
    // bogus libc/architecture mismatch on Claude. Neither names the directory
    // (#2663).
    //
    // Scoped to `conversation.cwd === null` on purpose. A conversation WITH a cwd
    // override is a different situation with different recovery advice, handled by
    // the guard directly above this one (#2551). The two conditions are disjoint on
    // the same field with no mutation between the reads, which is what lets them sit
    // side by side.
    //
    // `&& conversation.cwd === null` is load-bearing. Dropping it while leaving the
    // target as `default_cwd` refuses a healthy turn: a conversation working in a
    // live worktree, whose project root happens to be gone, would be told its
    // project directory no longer exists and offered `/update-project` for a
    // directory that turn never touches. Covered by `runs the turn when the cwd
    // override is healthy but default_cwd is gone`.
    //
    // Widening it the other way — to `conversation.cwd ?? default_cwd`, moving the
    // target with the condition — is instead unobservable here, because the guard
    // above already returns for every `cwd !== null` case. No test holds you to
    // that one. Keep it narrow anyway: it becomes observable the moment the guard
    // above is moved, narrowed, or removed, at which point this guard would answer
    // for a stale worktree with the wrong message, one that says nothing about
    // `isolation_env_id`.
    //
    // Refuses rather than falling back to the workspaces root the way the
    // `scopedCodebase === undefined` branch below does: relocating the agent into a
    // directory the user did not scope would widen its write scope without consent.
    if (conversation.codebase_id !== null && conversation.cwd === null) {
      const scoped = codebases.find(c => c.id === conversation.codebase_id);
      if (scoped !== undefined && !existsSync(scoped.default_cwd)) {
        getLog().warn(
          { conversationId, codebaseId: scoped.id, cwd: scoped.default_cwd },
          'orchestrator.codebase_cwd_missing'
        );
        await platform.sendMessage(
          conversationId,
          `This conversation's project directory no longer exists:\n\`${scoped.default_cwd}\`\n\n` +
            `The project "${scoped.name}" is still registered, but its folder is gone — ` +
            'deleted, moved, or on a volume that is no longer mounted.\n\n' +
            `- \`/update-project ${quoteCommandArg(scoped.name)} <new-path>\` ` +
            'to point it at the new location\n' +
            '- `/setproject <name>` to switch this conversation to a different project'
        );
        return;
      }
    }

    // Persist inbound turns only when core owns message storage.
    // Placed AFTER every early return that declines the turn — deterministic
    // commands (including `/workflow approve|reject`), the stale-worktree guard and
    // the missing-project guard above — so only AI-bound turns get a user row (no
    // orphaned user message without an assistant reply), and BEFORE the AI call so
    // the user row's timestamp precedes the assistant row's. A plain message at a
    // gate is NOT a refusal since #2577; it flows into the AI turn and earns its
    // user row.
    //
    // A new refusal that needs nothing computed below belongs above this block. One
    // that needs data from further down (workflow discovery, gate lookup) has to
    // hoist that dependency first, the way `codebases` was hoisted here — putting
    // the refusal below the persist instead is what orphans the row.
    // Fire-and-forget: a DB failure must not break platform delivery (#1182).
    if (platform.capabilities.messagePersistence === 'core') {
      messageDb
        .addMessage(conversation.id, 'user', message, undefined, userId)
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          getLog().warn(
            { err, errorType: err.constructor.name, conversationId },
            'orchestrator.user_message_persist_failed'
          );
        });
    }

    const {
      workflows: workflowsWithSource,
      errors: workflowErrors,
      syncResult,
      syncError,
      config: discoveredConfig,
      codebase: discoveredCodebase,
      remote: syncRemote,
    } = await discoverAllWorkflows(conversation);
    const workflows: readonly ResolvedWorkflow[] = workflowsWithSource.map(ws => ws.workflow);
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

    // Build workflow context for follow-up awareness
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
            const parsed =
              typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
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

    // A human gate paused in this conversation is CONTEXT for the agent, not a
    // branch in the router (#2565). Before #2565 any non-slash message here was
    // recorded as an approval — including an objection — so an interpretation
    // step never existed. Now the agent reads the gate alongside the message and
    // resolves it (or doesn't) through the explicit approve/reject verbs it
    // already has. Best-effort: getPausedWorkflowRun swallows DB errors and
    // returns null, and a missing section only means the agent isn't told.
    const pausedGateRun = await workflowDb.getPausedWorkflowRun(conversation.id);
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

    const fullPrompt = buildFullPrompt(
      message,
      issueContext,
      threadContext,
      attachedFiles,
      workflowContext,
      pausedGateContext
    );
    const scopedCodebase =
      conversation.codebase_id !== null
        ? codebases.find(c => c.id === conversation.codebase_id)
        : undefined;
    let cwd: string;
    if (scopedCodebase !== undefined) {
      cwd = conversation.cwd ?? scopedCodebase.default_cwd;
    } else {
      if (conversation.codebase_id !== null) {
        getLog().warn(
          { codebaseId: conversation.codebase_id },
          'orchestrator.scoped_codebase_not_found'
        );
      }
      cwd = await ensureArchonWorkspacesPath();
    }

    // 4. Update activity and get/create session
    await db.touchConversation(conversation.id);
    let session = await sessionDb.getActiveSession(conversation.id);
    if (!session) {
      session = await sessionDb.transitionSession(conversation.id, 'first-message', {
        ai_assistant_type: conversation.ai_assistant_type,
      });
    }

    // Reuse the config already loaded during workflow discovery (avoids a second disk read).
    // Fall back to loadConfig only when no codebase is scoped (discoveredConfig is undefined).
    const config = discoveredConfig ?? (await loadConfig());
    // Execution identity: the message sender when the adapter resolved one,
    // else the conversation creator (solo installs / legacy rows / surfaces
    // without auth). Sender-first mirrors the workflow executor, which
    // resolves prefs from the run starter — without it, a multi-user thread
    // would execute every turn on the creator's credentials (#1976).
    const executionUserId = userId ?? conversation.user_id ?? undefined;
    if (!userId && conversation.user_id && isPerUserProviderKeysEnabled()) {
      // No sender identity arrived with this turn while per-user credentials
      // are active — the turn executes (and bills) as the conversation
      // CREATOR. Distinguishes a degraded auth resolution from the normal
      // solo-install path (where per-user keys are off and this stays silent).
      getLog().warn(
        { conversationId, fallbackUserId: conversation.user_id },
        'orchestrator.execution_identity_creator_fallback'
      );
    }
    // Per-user AI prefs (Phase 3): the user's tiers/aliases/default-assistant
    // override install config (highest precedence). `{}` (no identity, no row,
    // or DB failure) keeps config-only behavior byte-for-byte.
    const userAiPrefs = executionUserId ? await resolveUserAiPrefsForChat(executionUserId) : {};
    let configuredProviderKey = userAiPrefs.defaultProvider ?? conversation.ai_assistant_type;
    let aiProfile: ReturnType<typeof buildAiProfile>;
    try {
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
        userTiers: userAiPrefs.tiers,
        userAliases: userAiPrefs.aliases,
      });
    } catch (profileErr) {
      // Structurally invalid STORED prefs (corrupt DB row) must not break the
      // user's chat — degrade to config-only. A broken config layer still
      // fails fast: the rebuild rethrows the same error.
      getLog().error(
        { err: profileErr as Error, userId: executionUserId },
        'orchestrator.user_ai_prefs_profile_invalid'
      );
      configuredProviderKey = conversation.ai_assistant_type;
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
      });
    }
    // Main chat model: per-user default_model > configured `large` tier >
    // install assistants.<p>.model > built-in tier default (#1998).
    const chatRequest = resolveChatModelRequest(aiProfile, configuredProviderKey, userAiPrefs, {
      assistants: config.assistants,
      tiers: config.tiers,
    });
    // Tier-fallback nudge (mirrors dag.model_provider_conflict): chat asks for
    // 'large'; when that tier is unset and a sibling preset answered, tell the
    // user ONCE PER CONVERSATION, non-blocking — the dedup Set below is what
    // keeps it from becoming a per-message banner (review C1). Only the main
    // chat request nags — the background title model ('small') falls back
    // silently. Delivery failure must never fail the chat turn.
    if (
      chatRequest.matchedTier !== undefined &&
      chatRequest.matchedTier !== 'large' &&
      !tierFallbackNudgedConversations.has(conversation.id)
    ) {
      // Mark BEFORE attempting delivery: a failed send shouldn't retry the
      // nudge on every subsequent message either.
      tierFallbackNudgedConversations.add(conversation.id);
      getLog().warn(
        {
          requestedTier: 'large',
          matchedTier: chatRequest.matchedTier,
          provider: chatRequest.provider,
          model: chatRequest.model,
        },
        'orchestrator.tier_fallback_nudge'
      );
      try {
        await platform.sendMessage(
          conversationId,
          `ℹ️ Model tier 'large' isn't configured — using the '${chatRequest.matchedTier}' preset ` +
            `(${chatRequest.provider}/${chatRequest.model ?? ''}). Set it in Settings → Model Tiers ` +
            'or `archon ai tier set large <provider> <model>`.'
        );
      } catch (nudgeErr) {
        getLog().warn(
          { err: nudgeErr as Error, conversationId },
          'orchestrator.tier_fallback_nudge_delivery_failed'
        );
      }
    }
    const providerKey = chatRequest.provider;
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
    // Per-user AI-provider credentials (Phase 2), delivered as env. Merged LAST
    // so a connected user's keys win over file/db env. No-op when the feature is
    // disabled or no execution identity resolved (sender, else creator).
    //
    // A request whose vendor has a connected credential that failed must not run: it
    // would authenticate with the host's login. A provider whose credentials have no
    // static vendor for the model (OpenCode, an unparsed Pi model) consumes no stored
    // credential, so it is not checked, as in workflow preflight.
    const delivery =
      isPerUserProviderKeysEnabled() && executionUserId
        ? await resolveUserProviderEnvForChat(executionUserId)
        : { env: {}, failed: new Map<string, CredentialFailure>(), credentials: undefined };
    const failedVendorFor = (
      provider: string,
      model: string | undefined
    ): { vendor: string; failure: CredentialFailure } | undefined => {
      // An unregistered provider fails where it is used (title generation falls back
      // to a truncated title); this check must not turn that into a failed turn.
      if (delivery.failed.size === 0 || !isRegisteredProvider(provider)) return undefined;
      const vendor = getRegistration(provider).credentials.vendorFor(model);
      const failure = vendor !== undefined ? delivery.failed.get(vendor) : undefined;
      return vendor !== undefined && failure !== undefined ? { vendor, failure } : undefined;
    };
    const failedTurnVendor = failedVendorFor(providerKey, chatRequest.model);
    if (failedTurnVendor) {
      throw new ConnectedCredentialUnavailableError(
        failedTurnVendor.vendor,
        failedTurnVendor.failure
      );
    }
    const userProviderEnv: Record<string, string> = delivery.env;
    const protectedEnvKeys = Object.keys(userProviderEnv);
    const effectiveEnv = { ...(config.envVars ?? {}), ...dbEnvVars, ...userProviderEnv };

    const caps = getProviderCapabilities(providerKey);
    // Warn if provider doesn't support env injection but env vars are configured
    if (Object.keys(effectiveEnv).length > 0) {
      if (!caps.envInjection) {
        getLog().warn(
          { provider: providerKey, envVarCount: Object.keys(effectiveEnv).length },
          'orchestrator.unsupported_env_injection'
        );
      }
    }

    // Providers with in-process tools launch and register through typed tools; the
    // others still write command lines that the command scan reads from the reply.
    let systemAppend = await buildOrchestratorSystemAppend(
      conversation,
      codebases,
      workflows,
      caps.nativeTools ? 'tools' : 'commands'
    );
    // Providers WITHOUT the in-process manage_run tool (OpenCode/Copilot) get a
    // system-prompt pointer to the `archon workflow …` CLI so they can still manage this
    // project's runs over bash. Native-tool providers get the tool below and are nudged to it
    // — adding the CLI pointer there would be redundant and steer them onto a bash path
    // that needs `archon` on PATH. Project-scoped only: the CLI commands require a
    // git-repo cwd, which unscoped chats (cwd ~/.archon/workspaces) don't have.
    if (conversation.codebase_id !== null && !caps.nativeTools) {
      systemAppend += `\n\n${buildRunManagementSection()}`;
    }
    const requestOptions: SendQueryOptions = {
      assistantConfig: { ...(config.assistants[providerKey] ?? {}) },
      env: Object.keys(effectiveEnv).length > 0 ? effectiveEnv : undefined,
      protectedEnvKeys: protectedEnvKeys.length > 0 ? protectedEnvKeys : undefined,
      userCredentialEnvKeys: Object.keys(userProviderEnv),
      model: chatRequest.model,
      appendSystemPrompt: systemAppend,
    };
    if (chatRequest.preset) {
      applyPresetToRequestOptions(providerKey, chatRequest.preset, requestOptions);
    }

    const titleRequest =
      !conversation.title && !trimmedMessage.startsWith('/')
        ? resolveModelRequest(aiProfile, 'small', configuredProviderKey)
        : undefined;
    if (titleRequest) {
      const titleOptions: SendQueryOptions = {
        model: titleRequest.model,
        assistantConfig: { ...(config.assistants[titleRequest.provider] ?? {}) },
        env: { ...(config.envVars ?? {}), ...dbEnvVars },
      };
      if (titleRequest.preset) {
        applyPresetToRequestOptions(titleRequest.provider, titleRequest.preset, titleOptions);
      }
      void generateTitleForUser(
        conversation.id,
        message,
        { provider: titleRequest.provider, options: titleOptions },
        cwd,
        executionUserId,
        undefined,
        delivery.credentials
      );
    }

    // 5. Send to AI provider
    const aiClient = getAgentProvider(providerKey);

    // Written by the `manage_run` tool when the agent resolves a human gate
    // during this turn, and acted on once the turn ends (#2565). Resolving a
    // gate and continuing the run are two halves of one action — the tool
    // records the intent so its call returns immediately, and the resume runs
    // here rather than blocking the agent loop on a whole workflow. Held in an
    // object because a `let` assigned only from a callback narrows to `null`.
    const gateResolution: { resolved: ResolvedGate | null } = { resolved: null };
    // Written by `invoke_workflow` and dispatched once the turn ends, for the same
    // reason: on a foreground surface the run would otherwise block the agent loop.
    const pendingLaunch: { launch: ChatLaunch | null } = { launch: null };

    // Providers with in-process native tools launch workflows and
    // register projects through typed tools in every chat. Project-scoped chats also
    // get `manage_run` to inspect and operate that project's runs.
    if (caps.nativeTools) {
      const tools = [
        buildInvokeWorkflowTool({
          workflows: workflowsWithSource,
          listCodebases: () => codebaseDb.listCodebases(),
          onLaunch: launch => {
            if (pendingLaunch.launch !== null) return pendingLaunch.launch;
            pendingLaunch.launch = launch;
            return null;
          },
        }),
        buildRegisterProjectTool({ registerProject }),
      ];
      if (conversation.codebase_id !== null) {
        tools.push(
          buildManageRunTool({
            actor,
            operations: createSqlWorkflowOperations(),
            codebaseId: conversation.codebase_id,
            surface: platform,
            // One continuation per turn: the resume runs in this conversation and
            // to completion, so a second gate resolved in the same turn is
            // declined rather than silently dropped (the tool tells the agent).
            onGateResolved: (run, action) => {
              if (gateResolution.resolved !== null) return false;
              gateResolution.resolved = { run, action };
              return true;
            },
          })
        );
      }
      requestOptions.nativeTools = tools;
    }

    const mode = platform.getStreamingMode();
    // The one line that ties a chat turn to both conversation ids, so grepping the
    // URL id finds the provider and model of every turn. `model` is read from the
    // options handed to the provider, never re-resolved, so it cannot disagree.
    getLog().info(
      {
        conversationId: conversation.id,
        platformConversationId: conversationId,
        provider: providerKey,
        model: requestOptions.model,
      },
      'orchestrator.chat_dispatch_started'
    );
    // `finally`, not straight-line code: the gate resolution is committed to the
    // DB the moment the tool call returns, so once the agent has resolved a gate
    // the continuation must run even if the rest of the turn throws — a provider
    // subprocess crash after a successful tool call would otherwise leave the run
    // resolved and parked with only a generic error to show for it. The outer
    // catch cannot cover this: it does not know about the resolution.
    // continueResolvedGateRun never throws, so this cannot mask the real error.
    const turn: ChatTurn = {
      startedAt: Date.now(),
      reported: false,
      failed: false,
      routed: false,
    };
    try {
      if (mode === 'stream') {
        await handleStreamMode(
          turn,
          !caps.nativeTools,
          platform,
          conversationId,
          message,
          codebases,
          workflowsWithSource,
          aiClient,
          fullPrompt,
          cwd,
          session,
          isolationHints,
          conversation,
          actor,
          issueContext,
          requestOptions
        );
      } else {
        await handleBatchMode(
          turn,
          !caps.nativeTools,
          platform,
          conversationId,
          message,
          codebases,
          workflowsWithSource,
          aiClient,
          fullPrompt,
          cwd,
          session,
          isolationHints,
          conversation,
          actor,
          issueContext,
          requestOptions
        );
      }
    } catch (error) {
      // A provider that throws mid-turn never reaches the handler's own report. Count
      // the turn as failed here, once, then let the outer catch tell the user.
      if (!turn.reported && !turn.routed) {
        reportChatTurn(turn, {
          platform: platform.getPlatformType(),
          provider: aiClient.getType(),
          model: requestOptions?.model,
          durationMs: Date.now() - turn.startedAt,
          outcome: 'failed',
        });
      }
      throw error;
    } finally {
      if (gateResolution.resolved !== null) {
        await continueResolvedGateRun(
          platform,
          conversationId,
          conversation,
          discoveredCodebase ?? null,
          gateResolution.resolved.run,
          gateResolution.resolved.action,
          actor,
          isolationHints
        );
      }
    }

    // After the gate continuation: a launch has committed nothing yet, so unlike a resolved
    // gate it is dropped when the turn throws or ends in an error result, and the user sees
    // the error instead. The command scan launches nothing in either case.
    if (pendingLaunch.launch !== null && turn.failed) {
      getLog().info(
        { conversationId, workflowName: pendingLaunch.launch.entry.workflow.name },
        'orchestrator.invoke_workflow_dropped_failed_turn'
      );
    } else if (pendingLaunch.launch !== null) {
      const { entry, codebase, prompt } = pendingLaunch.launch;
      getLog().info(
        { conversationId, workflowName: entry.workflow.name, codebaseId: codebase.id },
        'orchestrator.invoke_workflow_dispatching'
      );
      await dispatchOrchestratorWorkflow(
        platform,
        conversationId,
        conversation,
        codebase,
        {
          kind: 'start',
          definition: entry.workflow,
          args: prompt,
          parseWarnings: entry.parseWarnings,
        },
        actor,
        isolationHints,
        entry.source
      );
    }

    // Direct-chat turns may have written to source/. If there is local-only state
    // (uncommitted edits, unpushed commits), surface a one-line reminder so the
    // user can push or commit + push before the next worktree creation or
    // re-clone reclaims that work. No-op when no codebase is attached.
    // Use the codebase already fetched by discoverAllWorkflows — no second DB call.
    if (discoveredCodebase) {
      try {
        await reportUnpushedWorkInSource(conversationId, discoveredCodebase, platform);
      } catch (err) {
        getLog().warn(
          { err: err as Error, conversationId, codebaseId: conversation.codebase_id },
          'orchestrator.post_message_reminder_failed'
        );
      }
    }

    getLog().debug({ conversationId }, 'orchestrator_message_completed');
  } catch (error) {
    const err = toError(error);
    getLog().error({ err, conversationId }, 'orchestrator_message_failed');
    const userMessage = classifyAndFormatError(err, platform);
    try {
      await platform.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: toError(sendError), conversationId }, 'error_notification_failed');
    }
  }
}

/**
 * One direct-chat turn's telemetry state. Every `chat_turn_handled` for the turn goes
 * through {@link reportChatTurn}, so the dispatcher's failure report can tell whether a
 * mode handler already reported and never counts one turn twice.
 */
interface ChatTurn {
  readonly startedAt: number;
  reported: boolean;
  /** The turn ended in a provider error result; a launch queued during it is dropped. */
  failed: boolean;
  /**
   * The command scan routed the turn to a workflow or a project registration, which
   * report as `workflow_invoked` / `codebase_registered`, not as a chat turn. A throw
   * while dispatching it is not a failed chat turn. A dispatch that fails before its run
   * exists sends nothing, as a workflow-not-found or invalid-YAML dispatch does; the
   * executor's own run-creation failure is reported as `run_not_created`.
   */
  routed: boolean;
}

/**
 * The chat message for a failed turn's result. The provider's typed failure decides the
 * advice, as it decides retry in the workflow engine. A result without one comes from a
 * provider that does not report `failure` yet; its subtype and SDK detail still go
 * through credential redaction and are shown as diagnostics without inferred advice.
 */
function resultFailureMessage(msg: ResultChunk, surface: WorkflowCommandSurface): string {
  if (msg.failure !== undefined) return formatProviderFailure(msg.failure);
  const errorDetail = [msg.errorSubtype, ...(msg.errors ?? [])].filter(Boolean).join(': ');
  return classifyAndFormatError(new Error(errorDetail || 'AI result error'), surface);
}

function reportChatTurn(turn: ChatTurn, props: Parameters<typeof captureChatTurn>[0]): void {
  turn.reported = true;
  turn.failed = props.outcome === 'failed';
  captureChatTurn(props);
}

// ─── Streaming Mode ─────────────────────────────────────────────────────────

/**
 * Stream mode: send text chunks immediately for real-time UX (web, Telegram stream).
 * With `commandScan` on (providers without in-process tools), a detected orchestrator
 * command retracts the streamed text and dispatches.
 */
async function handleStreamMode(
  turn: ChatTurn,
  commandScan: boolean,
  platform: IPlatformAdapter,
  conversationId: string,
  originalMessage: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowWithSource[],
  aiClient: ReturnType<typeof getAgentProvider>,
  fullPrompt: string,
  cwd: string,
  session: { id: string; assistant_session_id: string | null },
  isolationHints: HandleMessageContext['isolationHints'],
  conversation: Conversation,
  actor: RunActor,
  issueContext?: string,
  requestOptions?: SendQueryOptions
): Promise<void> {
  const allMessages: string[] = [];
  let newSessionId: string | undefined;
  let commandDetected = false;
  let commandFullyParsed = false;
  // Usage summed over every `result` chunk of the turn, as the workflow engine sums a node.
  let turnResult: (ResultUsageTotal & { stopReason?: string }) | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    requestOptions
  )) {
    if (msg.type === 'agent_message_chunk') {
      // Accumulate only while the command is not yet fully captured; post-command
      // trailing chunks would corrupt the project-name token if joined without a
      // whitespace boundary, causing the parse regex to overshoot.
      if (!commandFullyParsed) {
        allMessages.push(msg.text);
      }
      if (!commandDetected) {
        // Check for orchestrator commands BEFORE streaming to frontend.
        // If detected, suppress this chunk and all future chunks — the full
        // response will be parsed post-loop and the command dispatched there.
        const accumulated = allMessages.join('');
        if (commandScan && hasCommandPrefix(accumulated)) {
          commandDetected = true;
          // If the complete command pattern is already present, stop accumulating —
          // no more chunks needed. This prevents trailing chunks from corrupting
          // the project-name token when the command was fully emitted in one chunk.
          if (isCommandFullyParsed(accumulated)) {
            commandFullyParsed = true;
          }
        } else {
          await platform.sendMessage(conversationId, msg.text);
        }
      } else if (!commandFullyParsed) {
        // Post-prefix: keep accumulating until the full command pattern is present.
        const accumulated = allMessages.join('');
        if (isCommandFullyParsed(accumulated)) {
          commandFullyParsed = true;
        }
      }
    } else if (msg.type === 'tool_call') {
      if (!commandDetected) {
        const toolMessage = formatToolCall(toolCallDisplayName(msg), msg.rawInput);
        await platform.sendMessage(conversationId, toolMessage, {
          category: 'tool_call_formatted',
        });
        if (platform.sendStructuredEvent) {
          await platform.sendStructuredEvent(conversationId, msg);
        }
      }
    } else if (msg.type === 'tool_call_update') {
      if (!commandDetected && platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    } else if (msg.type === 'warning') {
      if (!commandDetected) await platform.sendMessage(conversationId, `⚠️ ${msg.message}`);
    } else if (msg.type === 'result') {
      if (msg.isError && msg.errorSubtype === 'error_during_execution') {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            ...(msg.sessionId ? { staleSessionIdPreview: sessionPreview(msg.sessionId) } : {}),
            errors: msg.errors,
            stopReason: msg.stopReason,
          },
          'clearing_stale_session_id'
        );
        await tryPersistSessionId(session.id, null);
        newSessionId = undefined;
      } else if (msg.sessionId) {
        newSessionId = msg.sessionId;
      }
      // Defense-in-depth: errorSubtype === 'success' is the Claude SDK's marker
      // for a clean stop_sequence termination (the SDK sets is_error: true
      // alongside subtype: 'success' to encode "non-default termination, not a
      // failure"). The Claude provider already filters this; the guard here
      // defends against a third-party IAgentProvider that forwards the SDK
      // pair raw — without it, direct chat would surface a spurious error to
      // the user and drop the actual conversation output.
      if (msg.failure !== undefined || (msg.isError && msg.errorSubtype !== 'success')) {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            failureClass: msg.failure?.class,
            errors: msg.errors,
            stopReason: msg.stopReason,
          },
          'ai_result_error'
        );
        await platform.sendMessage(conversationId, resultFailureMessage(msg, platform));
        if (newSessionId) {
          await tryPersistSessionId(session.id, newSessionId);
        }
        // Anonymous telemetry: AI returned an error result for this chat turn.
        reportChatTurn(turn, {
          platform: platform.getPlatformType(),
          provider: aiClient.getType(),
          model: requestOptions?.model,
          durationMs: Date.now() - turn.startedAt,
          outcome: 'failed',
        });
        return;
      }
      if (!commandDetected && platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
      turnResult = {
        ...addResultUsage(turnResult ?? {}, msg),
        stopReason: msg.stopReason ?? turnResult?.stopReason,
      };
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (allMessages.length === 0) {
    // Intentionally NOT counted in chat_turn_handled — an empty response is
    // neither a completed nor a failed turn worth measuring.
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  const fullResponse = allMessages.join('');
  const commands = commandScan
    ? parseOrchestratorCommands(
        fullResponse,
        codebases,
        workflows.map(ws => ws.workflow)
      )
    : NO_COMMANDS;

  if (commands.workflowInvocation) {
    turn.routed = true;
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
      actor,
      issueContext
    );
    return;
  }

  if (commands.projectRegistration) {
    turn.routed = true;
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

  // Text was already streamed — nothing more to send.
  // Adapter-owned storage must not get a second copy of the assistant reply (#1182).
  if (platform.capabilities.messagePersistence === 'core' && fullResponse) {
    messageDb.addMessage(conversation.id, 'assistant', fullResponse).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().warn(
        { err, errorType: err.constructor.name, conversationId },
        'orchestrator.assistant_message_persist_failed'
      );
    });
  }
  await maybeSendResultFooter(platform, conversationId, turnResult);
  // Anonymous telemetry: one completed direct-chat turn. The workflow-invocation
  // and project-registration paths return above without reaching this — those
  // are covered by workflow_invoked / codebase_registered instead. Platform +
  // provider only, never message content.
  reportChatTurn(turn, {
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions?.model,
    // durationMs deliberately measures from mode-handler entry — it includes
    // pre-AI setup, i.e. "time the user waited", not pure model latency.
    durationMs: Date.now() - turn.startedAt,
    costUsd: turnResult?.cost,
    tokensIn: turnResult?.tokens?.input,
    tokensOut: turnResult?.tokens?.output,
    outcome: 'completed',
  });
}

// ─── Batch Mode ─────────────────────────────────────────────────────────────

/**
 * Batch mode: accumulate all chunks, filter tool indicators, send final clean summary.
 * Used by Slack, GitHub, Discord (batch), and CLI.
 */
async function handleBatchMode(
  turn: ChatTurn,
  commandScan: boolean,
  platform: IPlatformAdapter,
  conversationId: string,
  originalMessage: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowWithSource[],
  aiClient: ReturnType<typeof getAgentProvider>,
  fullPrompt: string,
  cwd: string,
  session: { id: string; assistant_session_id: string | null },
  isolationHints: HandleMessageContext['isolationHints'],
  conversation: Conversation,
  actor: RunActor,
  issueContext?: string,
  requestOptions?: SendQueryOptions
): Promise<void> {
  const allChunks: { type: string; content: string }[] = [];
  const assistantMessages: string[] = [];
  let assistantChunksTruncated = false;
  let totalChunksTruncated = false;
  let newSessionId: string | undefined;
  let commandDetected = false;
  let commandFullyParsed = false;
  // Usage summed over every `result` chunk of the turn, as the workflow engine sums a node.
  let turnResult: (ResultUsageTotal & { stopReason?: string }) | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    requestOptions
  )) {
    if (msg.type === 'agent_message_chunk') {
      // Always record in allChunks for debug logging; accumulate assistantMessages
      // only while the command is not yet fully captured (same reason as stream mode).
      allChunks.push({ type: 'assistant', content: msg.text });
      if (!commandFullyParsed) {
        assistantMessages.push(msg.text);
      }

      // Cap assistant-only chunks while no command has been detected.  Once
      // commandDetected flips to true we stop shifting so that all tokens of
      // the in-flight command are preserved — shifting the prefix away would
      // break both the prefix and full-command regexes.  As a consequence, if
      // the AI starts a command prefix but never completes it, assistantMessages
      // can grow unbounded from the per-assistant perspective; the outer
      // MAX_BATCH_TOTAL_CHUNKS guard on allChunks (below) is the true hard cap
      // for that edge case.
      if (
        !commandDetected &&
        !commandFullyParsed &&
        assistantMessages.length > MAX_BATCH_ASSISTANT_CHUNKS
      ) {
        assistantMessages.shift();
        assistantChunksTruncated = true;
      }

      if (!commandDetected) {
        const accumulated = assistantMessages.join('');
        if (commandScan && hasCommandPrefix(accumulated)) {
          commandDetected = true;
          if (isCommandFullyParsed(accumulated)) {
            commandFullyParsed = true;
          }
        }
      } else if (!commandFullyParsed) {
        const accumulated = assistantMessages.join('');
        if (isCommandFullyParsed(accumulated)) {
          commandFullyParsed = true;
        }
      }
    } else if (msg.type === 'tool_call') {
      if (!commandDetected) {
        const toolMessage = formatToolCall(toolCallDisplayName(msg), msg.rawInput);
        allChunks.push({ type: 'tool', content: toolMessage });
        getLog().debug({ toolName: msg.name }, 'tool_call');
      }
    } else if (msg.type === 'warning') {
      // A warning surfaces as it arrives, not batched into the reply.
      if (!commandDetected) await platform.sendMessage(conversationId, `⚠️ ${msg.message}`);
    } else if (msg.type === 'result') {
      if (msg.isError && msg.errorSubtype === 'error_during_execution') {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            ...(msg.sessionId ? { staleSessionIdPreview: sessionPreview(msg.sessionId) } : {}),
            errors: msg.errors,
            stopReason: msg.stopReason,
          },
          'clearing_stale_session_id'
        );
        await tryPersistSessionId(session.id, null);
        newSessionId = undefined;
      } else if (msg.sessionId) {
        newSessionId = msg.sessionId;
      }
      // Defense-in-depth: errorSubtype === 'success' is the Claude SDK's marker
      // for a clean stop_sequence termination (the SDK sets is_error: true
      // alongside subtype: 'success' to encode "non-default termination, not a
      // failure"). The Claude provider already filters this; the guard here
      // defends against a third-party IAgentProvider that forwards the SDK
      // pair raw — without it, direct chat would surface a spurious error to
      // the user and drop the actual conversation output.
      if (msg.failure !== undefined || (msg.isError && msg.errorSubtype !== 'success')) {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            failureClass: msg.failure?.class,
            errors: msg.errors,
            stopReason: msg.stopReason,
          },
          'ai_result_error'
        );
        await platform.sendMessage(conversationId, resultFailureMessage(msg, platform));
        if (newSessionId) {
          await tryPersistSessionId(session.id, newSessionId);
        }
        // Anonymous telemetry: AI returned an error result for this chat turn.
        reportChatTurn(turn, {
          platform: platform.getPlatformType(),
          provider: aiClient.getType(),
          model: requestOptions?.model,
          durationMs: Date.now() - turn.startedAt,
          outcome: 'failed',
        });
        return;
      }
      turnResult = {
        ...addResultUsage(turnResult ?? {}, msg),
        stopReason: msg.stopReason ?? turnResult?.stopReason,
      };
    }

    // Always enforce the total-chunk cap regardless of commandDetected — allChunks grows
    // unconditionally now (for debug logging), so without this guard it would be unbounded.
    if (allChunks.length > MAX_BATCH_TOTAL_CHUNKS) {
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
    // Intentionally NOT counted in chat_turn_handled — an empty response is
    // neither a completed nor a failed turn worth measuring.
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  // Parse commands from raw joined text — filterToolIndicators inserts '\n\n---\n\n'
  // separators between array elements and then splits/rejoins with '\n\n', creating
  // separator lines that break multi-chunk command text (name and path appear on
  // separate lines from '/register-project'). Raw join preserves the command as a
  // contiguous string. User-visible output still comes from filterToolIndicators.
  const commands = commandScan
    ? parseOrchestratorCommands(
        assistantMessages.join(''),
        codebases,
        workflows.map(ws => ws.workflow)
      )
    : NO_COMMANDS;

  if (commands.workflowInvocation) {
    turn.routed = true;
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
      actor,
      issueContext
    );
    return;
  }

  if (commands.projectRegistration) {
    turn.routed = true;
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
  // Adapter-owned storage must not get a second copy of the assistant reply (#1182).
  if (platform.capabilities.messagePersistence === 'core' && finalMessage) {
    messageDb.addMessage(conversation.id, 'assistant', finalMessage).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().warn(
        { err, errorType: err.constructor.name, conversationId },
        'orchestrator.assistant_message_persist_failed'
      );
    });
  }
  await maybeSendResultFooter(platform, conversationId, turnResult);
  // Anonymous telemetry: one completed direct-chat turn (same exclusion
  // rationale as the stream-mode capture in handleStreamMode above).
  reportChatTurn(turn, {
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions?.model,
    // durationMs deliberately measures from mode-handler entry — it includes
    // pre-AI setup, i.e. "time the user waited", not pure model latency.
    durationMs: Date.now() - turn.startedAt,
    costUsd: turnResult?.cost,
    tokensIn: turnResult?.tokens?.input,
    tokensOut: turnResult?.tokens?.output,
    outcome: 'completed',
  });
}

/**
 * Call the adapter's optional `sendResultFooter` hook with the final result
 * metadata from a direct-chat turn. Skips when the adapter doesn't implement
 * it, when there's no metadata to surface, or when the call itself fails —
 * cost footers are informational and must not block the conversation.
 */
async function maybeSendResultFooter(
  platform: IPlatformAdapter,
  conversationId: string,
  info: { cost?: number; tokens?: TokenUsage; stopReason?: string } | undefined
): Promise<void> {
  if (!info) return;
  if (info.cost === undefined && info.tokens === undefined) return;
  if (!platform.sendResultFooter) return;
  try {
    await platform.sendResultFooter(conversationId, info);
  } catch (error) {
    getLog().warn({ err: toError(error), conversationId }, 'orchestrator.result_footer_failed');
  }
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
  workflows: readonly WorkflowWithSource[],
  invocation: WorkflowInvocation,
  originalMessage: string,
  isolationHints: HandleMessageContext['isolationHints'],
  actor: RunActor,
  issueContext?: string
): Promise<void> {
  const { workflowName, projectName, remainingMessage } = invocation;

  // Send explanation text before dispatching
  if (remainingMessage) {
    await platform.sendMessage(conversationId, remainingMessage);
  }

  // Find the codebase and workflow (supports partial name matching)
  const codebase = findCodebaseByName(codebases, projectName);
  // Keep the discovery ENTRY, not just the definition: it carries the parse
  // warnings this path used to discard (#2213).
  const workflowEntry = workflows.find(ws => ws.workflow.name === workflowName);
  const workflow = findWorkflow(
    workflowName,
    workflows.map(ws => ws.workflow)
  );

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
      {
        kind: 'start',
        definition: workflow,
        args: workflowPrompt,
        parseWarnings: workflowEntry?.parseWarnings,
      },
      actor,
      isolationHints,
      workflowEntry?.source
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
      `Workflow \`${workflowName}\` is not available. Use \`${spellWorkflowCommand(platform, 'list')}\` to see available workflows.`
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
  // Normalize before extraction so that Mode A's bold markers ('**') are
  // stripped from the command line; otherwise textBeforeReg would include a
  // trailing '**' when the model wrapped the command in markdown bold.
  const normalizedForExtraction = normalizeCommandText(fullResponse);
  // Match line-anchored to avoid landing on a prose mention of "/register-project".
  const regLineMatch = /^\/register-project\b/m.exec(normalizedForExtraction);
  if (!regLineMatch) {
    // Parsing already succeeded upstream from raw concatenated assistant chunks.
    // If extraction on filtered text fails, skip preamble extraction but still
    // execute registration to avoid silently dropping a valid command.
    getLog().warn({ conversationId }, 'orchestrator.extract_no_line_match');
  }
  const textBeforeReg = regLineMatch
    ? normalizedForExtraction.slice(0, regLineMatch.index).trim()
    : '';
  if (textBeforeReg) {
    await platform.sendMessage(conversationId, textBeforeReg);
  }

  // Register the project
  const regResult = await registerProject(registration);
  await platform.sendMessage(conversationId, regResult);
}
