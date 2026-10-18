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
import { existsSync } from 'fs';
import type { IPlatformAdapter, HandleMessageContext, CommandResult } from '../types';
import type { SendQueryOptions } from '@archon/providers/types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { classifyAndFormatError } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { quoteCommandArg } from '../utils/command-args';
import { getProviderCapabilities } from '@archon/providers';
import { getAgentProvider } from '../services/provider-admission';
import { buildManageRunTool } from './manage-run-tool';
import { buildInvokeWorkflowTool, buildRegisterProjectTool, type ChatLaunch } from './chat-tools';
import { ensureArchonWorkspacesPath } from '@archon/paths';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
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
import { type ChatTurn, handleBatchMode, handleStreamMode, reportChatTurn } from './chat-turn';
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

/**
 * Conversations (DB ids) already nudged about a tier fallback. Process-lifetime
 * memory is intentional and sufficient: the nudge is a discovery aid, not
 * state — a server restart re-nudging once per conversation is acceptable.
 */
const tierFallbackNudgedConversations = new Set<string>();

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
