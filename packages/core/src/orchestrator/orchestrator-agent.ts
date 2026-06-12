/**
 * Orchestrator Agent - Main entry point for AI-powered message routing
 *
 * Single entry point for all platforms:
 * - Knows all registered projects and workflows upfront
 * - Can answer directly or invoke workflows
 * - Does NOT require a project to be selected before starting a conversation
 */
import { existsSync } from 'fs';
import { createLogger, captureChatTurn, captureApprovalResolved } from '@archon/paths';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  AttachedFile,
} from '../types';
import type { SendQueryOptions, TokenUsage } from '@archon/providers/types';
import { ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '@archon/workflows/utils/tool-formatter';
import { classifyAndFormatError } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { getAgentProvider, getProviderCapabilities } from '@archon/providers';
import { buildManageRunTool } from './manage-run-tool';
import { getArchonWorkspacesPath, ensureArchonWorkspacesPath } from '@archon/paths';
import { syncArchonToWorktree } from '../utils/worktree-sync';
import { execFileAsync, syncWorkspace, toBranchName, toRepoPath } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow, resolveWorkflowName } from '@archon/workflows/router';
import { executeWorkflow, hydrateResumableRun } from '@archon/workflows/executor';
import {
  assertWorkflowRequirementsMet,
  WorkflowRequirementError,
} from '@archon/workflows/utils/workflow-requirements';
import type {
  WorkflowDefinition,
  WorkflowWithSource,
  WorkflowLoadError,
  WorkflowSource,
} from '@archon/workflows/schemas/workflow';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { getDecryptedAccessToken } from '../db/user-github-token-store';
import { isPerUserProviderKeysEnabled } from '../credentials/config';
import { deliverCredential } from '../credentials/delivery';
import { listDecryptedUserProviderCredentials } from '../db/user-provider-key-store';
import { getUserAiPrefs, type UserAiPrefs } from '../db/user-ai-prefs-store';
import { createWorkflowDeps } from '../workflows/store-adapter';
import { loadConfig } from '../config/config-loader';
import type { MergedConfig } from '../config/config-types';
import { generateAndSetTitle } from '../services/title-generator';
import { validateAndResolveIsolation, dispatchBackgroundWorkflow } from './orchestrator';
import { IsolationBlockedError } from '@archon/isolation';
import {
  buildOrchestratorSystemAppend,
  buildRunManagementSection,
  formatWorkflowContextSection,
} from './prompt-builder';
import type { WorkflowResultContext } from './prompt-builder';
import * as messageDb from '../db/messages';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import { getCodebaseEnvVars } from '../db/env-vars';
import type { ApprovalContext } from '@archon/workflows/schemas/workflow-run';
import {
  buildAiProfile,
  isLiteralSpec,
  isTierName,
  resolveModelSpec,
  resolveTierWithFallback,
  routePresetEffort,
  type ModelAliasPreset,
  type TierName,
} from '@archon/workflows/model-validation';

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
function applyPresetToRequestOptions(
  provider: string,
  preset: ModelAliasPreset,
  options: SendQueryOptions
): void {
  if (preset.thinking !== undefined) {
    options.nodeConfig = { ...(options.nodeConfig ?? {}), thinking: preset.thinking };
  }

  if (preset.effort === undefined) return;

  const routed = routePresetEffort(provider, preset.effort);
  if (!routed) {
    // Cross-provider effort mismatch — warn instead of silently dropping.
    getLog().warn({ provider, effort: preset.effort }, 'orchestrator.preset_effort_unsupported');
    return;
  }
  if (routed.field === 'effort') {
    options.nodeConfig = { ...(options.nodeConfig ?? {}), effort: routed.value };
  } else {
    options.assistantConfig = {
      ...(options.assistantConfig ?? {}),
      modelReasoningEffort: routed.value,
    };
  }
}

interface ResolvedModelRequest {
  provider: string;
  model: string | undefined;
  preset?: ModelAliasPreset;
  /** When `modelRef` was a tier: which tier in the fallback chain matched. */
  matchedTier?: TierName;
}

function resolveModelRequest(
  aiProfile: ReturnType<typeof buildAiProfile>,
  modelRef: string,
  fallbackProvider: string
): ResolvedModelRequest {
  if (isTierName(modelRef)) {
    const { preset, matchedTier } = resolveTierWithFallback(aiProfile, modelRef);
    return { provider: preset.provider, model: preset.model, preset, matchedTier };
  }
  const spec = resolveModelSpec(aiProfile, modelRef);
  if (isLiteralSpec(spec)) {
    return { provider: fallbackProvider, model: spec.literal };
  }
  return { provider: spec.provider, model: spec.model, preset: spec };
}

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

// Prefix patterns: fire as soon as the command keyword is seen.
const INVOKE_WORKFLOW_PREFIX_RE = /^\/invoke-workflow\s/m;
const REGISTER_PROJECT_PREFIX_RE = /^\/register-project\s/m;

// Full-command patterns: fire once all required tokens are present.
// These determine when accumulation can stop — further chunks cannot add
// required parse tokens and could corrupt already-captured ones.
//
// INVOKE_WORKFLOW_FULL_RE uses a test() object because the stop condition must account
// for the optional --prompt parameter:
//   - If --prompt "..." is present with a closing quote → fully parsed.
//   - If --prompt is started but not closed → keep accumulating for the closing quote.
//   - If no --prompt and the line is terminated (\n) → fully parsed (no more params).
//   - If no --prompt and EOS (no \n yet) → keep accumulating in case --prompt follows.
// A plain regex would fire as soon as --project <token> matched, dropping a --prompt
// that arrives in a later chunk and causing synthesizedPrompt to be lost.
const INVOKE_WORKFLOW_FULL_RE = {
  test(text: string): boolean {
    // Match the invoke-workflow line up to and including its terminator (\n) or end of string.
    const lineMatch = /^\/invoke-workflow[^\r\n]*(\r?\n|$)/m.exec(text);
    if (!lineMatch) return false;
    const line = lineMatch[0].replace(/(\r?\n)?$/, '');
    // Must have workflow name and --project token before we consider stopping.
    if (!/--project[\s=]+\S+/.test(line)) return false;
    const isEos = !lineMatch[0].endsWith('\n');
    // Check for optional --prompt parameter (system prompt specifies it follows --project).
    const promptKeywordMatch = /--prompt\s+/.exec(line);
    if (promptKeywordMatch) {
      const afterPrompt = line.slice(promptKeywordMatch.index + promptKeywordMatch[0].length);
      if (afterPrompt.startsWith('"')) {
        return /^"(?:[^"\\]|\\.)*"/.test(afterPrompt);
      }
      if (afterPrompt.startsWith("'")) {
        return /^'(?:[^'\\]|\\.)*'/.test(afterPrompt);
      }
      // Unquoted --prompt value: require line terminator.
      return !isEos;
    }
    // No --prompt yet: require line terminator so a --prompt in a later chunk is not missed.
    return !isEos;
  },
};
// REGISTER_PROJECT_FULL_RE uses a test() object instead of a plain regex because the
// stop condition must be conservative:
//   - Unquoted paths: require the line to be terminated (\n or end of stream preceded
//     by a non-whitespace char) so a space-containing path like "/home/user/my project"
//     is not declared complete after "my" arrives.
//   - Quoted paths: require the closing quote so we don't stop mid-path.
// This mirrors parseOrchestratorCommands' /^..\s+(.+)$/m pattern for the path capture.
const REGISTER_PROJECT_FULL_RE = {
  test(text: string): boolean {
    // Match the register-project line up to and including its terminator (\n) or end of string.
    const lineMatch = /^\/register-project[^\r\n]*(\r?\n|$)/m.exec(text);
    if (!lineMatch) return false;
    // Only treat end-of-string as a line terminator when at least one non-whitespace
    // character follows the project name — avoids matching a partial "/register-project "
    // line that was cut mid-word.
    const isEos = !lineMatch[0].endsWith('\n');
    const line = lineMatch[0].replace(/(\r?\n)?$/, '');
    const rest = line.replace(/^\/register-project\s+/, '');
    if (rest === line) return false; // no whitespace after command keyword
    const nameEnd = rest.search(/\s/);
    if (nameEnd === -1) return false; // no path token yet
    const projectPath = rest.slice(nameEnd).trimStart();
    if (!projectPath) return false;
    if (projectPath.startsWith('"')) {
      // Quoted path: require closing quote
      return /^"(?:[^"\\]|\\.)*"/.test(projectPath);
    }
    if (projectPath.startsWith("'")) {
      return /^'(?:[^'\\]|\\.)*'/.test(projectPath);
    }
    // Unquoted path: require line terminator so we don't freeze on a partial path with spaces
    return !isEos;
  },
};

/**
 * Strip markdown bold/italic decorators from slash-command lines.
 * Pi and other models occasionally emit **\/register-project ...** or
 * *\/invoke-workflow ...* instead of a bare slash command. The leading
 * asterisks cause both prefix and full-command regexes to miss the line.
 * Only lines whose first non-asterisk character is '/' are affected.
 */
function normalizeCommandText(text: string): string {
  return text.replace(/^\s*\*+(\/[^\n]*?)\**\s*$/gm, '$1');
}

/** Returns true once accumulated text contains a complete orchestrator command. */
function isCommandFullyParsed(accumulated: string): boolean {
  const normalized = normalizeCommandText(accumulated);
  return INVOKE_WORKFLOW_FULL_RE.test(normalized) || REGISTER_PROJECT_FULL_RE.test(normalized);
}

/**
 * Resolve the env-only per-user AI-provider credential bag for a direct-chat
 * turn (Phase 2). Drops deliveries that require file writes (Codex
 * `CODEX_HOME/auth.json` for the ChatGPT subscription path) because chat has
 * no per-call scratch directory — those rely on the workflow inject path that
 * provides an `artifactsDir`.
 *
 * NEVER THROWS — returns `{}` on any failure so the chat turn falls back to
 * whatever process-global env was already in place.
 */
async function resolveUserProviderEnvForChat(userId: string): Promise<Record<string, string>> {
  try {
    const creds = await listDecryptedUserProviderCredentials(userId);
    const env: Record<string, string> = {};
    for (const { provider, cred } of creds) {
      try {
        // artifactsDir intentionally empty: chat doesn't host file deliveries.
        const result = deliverCredential(provider, cred, { artifactsDir: '' });
        if (!result.files?.length) Object.assign(env, result.env);
      } catch (err) {
        getLog().error(
          { err: err as Error, userId, provider },
          'orchestrator.provider_creds_deliver_failed'
        );
      }
    }
    return env;
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'orchestrator.user_provider_env_resolve_failed');
    return {};
  }
}

/**
 * Conversations (DB ids) already nudged about a tier fallback. Process-lifetime
 * memory is intentional and sufficient: the nudge is a discovery aid, not
 * state — a server restart re-nudging once per conversation is acceptable.
 */
const tierFallbackNudgedConversations = new Set<string>();

/**
 * Resolve the user's personal AI prefs (tiers / aliases / default assistant)
 * for a direct-chat turn (Phase 3). Folded into `buildAiProfile` as the
 * highest-precedence layer.
 *
 * NEVER THROWS — returns `{}` on any failure so model resolution falls back
 * to install-wide config exactly as before.
 */
async function resolveUserAiPrefsForChat(userId: string): Promise<UserAiPrefs> {
  try {
    return await getUserAiPrefs(userId);
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'orchestrator.user_ai_prefs_resolve_failed');
    return {};
  }
}

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
 * Resolve a codebase by name using 4-tier fuzzy matching.
 * Tiers: exact → case-insensitive → prefix → substring.
 * Returns undefined if not found; throws on ambiguity within a tier.
 *
 * Mirrors `resolveWorkflowName` (packages/workflows/src/router.ts) but uses
 * prefix instead of suffix for tier 3 — project names don't follow the
 * `archon-X` suffix convention workflows use.
 */
function resolveCodebaseName(name: string, codebases: readonly Codebase[]): Codebase | undefined {
  const exact = codebases.find(c => c.name === name);
  if (exact) return exact;

  const lowerName = name.toLowerCase();

  function checkTier(matches: readonly Codebase[], logEvent: string): Codebase | undefined {
    if (matches.length === 1) {
      getLog().debug({ requested: name, matched: matches[0].name }, logEvent);
      return matches[0];
    }
    if (matches.length > 1) {
      const candidates = matches.map(c => `  - ${c.name}`).join('\n');
      throw new Error(`Ambiguous project name '${name}'. Did you mean:\n${candidates}`);
    }
    return undefined;
  }

  return (
    checkTier(
      codebases.filter(c => c.name.toLowerCase() === lowerName),
      'project.set_resolve_case_insensitive_match'
    ) ??
    checkTier(
      codebases.filter(c => c.name.toLowerCase().startsWith(lowerName)),
      'project.set_resolve_prefix_match'
    ) ??
    checkTier(
      codebases.filter(c => c.name.toLowerCase().includes(lowerName)),
      'project.set_resolve_substring_match'
    )
  );
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

  // Strip markdown bold/italic decorators from slash command lines before matching.
  // Pi models occasionally emit **\/register-project ...** or **\/invoke-workflow ...**.
  const normalizedResponse = normalizeCommandText(response);

  // Parse /invoke-workflow {name} --project {project-name}
  // Use (\S+) for project name to avoid capturing trailing text on the same line
  // (e.g., when AI appends tool call indicators or continues text after the command).
  // --project MUST appear before --prompt; this order is specified in the system prompt
  // template. Commands with --prompt before --project will not match.
  const invokePattern = /^\/invoke-workflow\s+(\S+)\s+--project[\s=]+(\S+)/m;
  const invokeMatch = invokePattern.exec(normalizedResponse);
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
        const commandIndex = normalizedResponse.indexOf(invokeMatch[0]);
        const remainingMessage = normalizedResponse.slice(0, commandIndex).trim();

        // Extract optional --prompt "..." parameter (double or single quotes)
        const commandText = normalizedResponse.slice(commandIndex);
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
  const registerMatch = registerPattern.exec(normalizedResponse);
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
  isolationHints?: HandleMessageContext['isolationHints'],
  userId?: string,
  /**
   * Discovery source of the workflow — telemetry only (bundled workflows
   * report their real name, custom ones report "custom"). Optional: callers
   * that don't have it readily in scope omit it and the run reports "custom".
   */
  source?: WorkflowSource
): Promise<void> {
  // Capability gate: hard-fail before any worktree/clone/AI cost if the
  // workflow declares `requires: [github]` and the originating user hasn't
  // connected. No-op when per-user GitHub is disabled (solo PAT installs).
  if (isPerUserGitHubEnabled() && workflow.requires?.length) {
    const githubConnected = userId ? Boolean(await getDecryptedAccessToken(userId)) : false;
    try {
      assertWorkflowRequirementsMet(workflow, { githubConnected });
    } catch (err) {
      if (err instanceof WorkflowRequirementError) {
        getLog().info(
          { workflowName: workflow.name, conversationId, userId, requirement: err.requirement },
          'workflow.requirement_unmet'
        );
        await platform.sendMessage(conversationId, err.message);
        return;
      }
      throw err;
    }
  }

  // Auto-attach project to conversation
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
  });

  // Validate and resolve isolation.
  // A workflow with `worktree.enabled: false` short-circuits the resolver entirely
  // and runs in the live checkout — no worktree creation, no env row. This is the
  // declarative equivalent of CLI `--no-worktree` for workflows that should always
  // run live (e.g. read-only triage, docs generation on the main checkout).
  let cwd: string;
  if (workflow.worktree?.enabled === false) {
    getLog().info(
      { workflowName: workflow.name, conversationId, codebaseId: codebase.id },
      'workflow.worktree_disabled_by_policy'
    );
    cwd = codebase.default_cwd;
  } else {
    try {
      const result = await validateAndResolveIsolation(
        { ...conversation, codebase_id: codebase.id },
        codebase,
        platform,
        conversationId,
        isolationHints,
        false,
        userId
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
  }

  // Dispatch workflow.
  // Resume detection runs for ALL platforms: check if a prior run for this workflow
  // is in a resumable state (paused/failed-by-approval) in this conversation+codebase
  // before dispatching fresh. This ensures chat platforms (slack, telegram, discord,
  // github) resume after approval gates just like web does.
  const resumableRun = await workflowDb.findResumableRunByParentConversation(
    workflow.name,
    conversation.id,
    codebase.id
  );
  if (resumableRun?.working_path) {
    getLog().info(
      {
        workflowName: workflow.name,
        resumableRunId: resumableRun.id,
        workingPath: resumableRun.working_path,
        platformType: platform.getPlatformType(),
      },
      'orchestrator.foreground_resume_detected'
    );
    // Hydrate the already-found candidate. If hydration returns null the
    // prior run had nothing worth resuming (zero completed nodes, no loop
    // gate) — surface that to the user and fall through to a fresh run on
    // the same worktree rather than silently restarting.
    const deps = createWorkflowDeps();
    let prepared: Awaited<ReturnType<typeof hydrateResumableRun>>;
    try {
      prepared = await hydrateResumableRun(deps, resumableRun);
    } catch (err) {
      // resumeWorkflowRun is a compare-and-swap: if another surface (web Resume,
      // a concurrent re-dispatch, the CLI) already claimed this run, it throws
      // WorkflowNotResumableError. Surface a friendly note instead of leaking the
      // raw internal string to the generic failure catch, and do NOT fall through
      // to a fresh run — the other resumer owns the worktree (#1830 I2).
      if (err instanceof workflowDb.WorkflowNotResumableError) {
        getLog().info(
          { workflowName: workflow.name, runId: resumableRun.id, status: err.currentStatus },
          'orchestrator.resume_lost_race'
        );
        await platform.sendMessage(
          conversationId,
          `⚠️ **${workflow.name}** is already being resumed (status: ${err.currentStatus}). ` +
            'No action taken — follow the existing run for progress.'
        );
        return;
      }
      throw err;
    }
    if (prepared) {
      await executeWorkflow(
        deps,
        platform,
        conversationId,
        resumableRun.working_path,
        workflow,
        userMessage,
        conversation.id,
        {
          codebaseId: codebase.id,
          parentConversationId: conversation.id,
          userId,
          source,
          ...prepared,
        }
      );
    } else {
      await platform.sendMessage(
        conversationId,
        `⚠️ Prior run for **${workflow.name}** had no completed nodes; starting fresh in the same worktree.`
      );
      await executeWorkflow(
        deps,
        platform,
        conversationId,
        resumableRun.working_path,
        workflow,
        userMessage,
        conversation.id,
        {
          codebaseId: codebase.id,
          parentConversationId: conversation.id,
          userId,
          source,
        }
      );
    }
  } else if (platform.getPlatformType() === 'web' && !workflow.interactive) {
    // Background dispatch: web-only, non-interactive workflows with no resumable run
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
        userId,
        source,
      },
      workflow
    );
  } else {
    // Fresh foreground execution: web interactive workflows + all chat platforms
    await executeWorkflow(
      createWorkflowDeps(),
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversation.id,
      {
        codebaseId: codebase.id,
        parentConversationId: conversation.id,
        userId,
        source,
      }
    );
  }
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
      { err: error as Error, sessionId, persistedValue: assistantSessionId },
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
    // Home-scoped workflows at ~/.archon/workflows/ are discovered automatically
    // by discoverWorkflowsWithConfig — no option needed.
    const result = await discoverWorkflowsWithConfig(getArchonWorkspacesPath(), loadConfig);
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
        // This path must remain non-destructive: users and agents can write to source/.
        // Non-fatal: if fetch fails (network, no remote), proceed with local state.
        try {
          syncResult = await syncWorkspace(
            toRepoPath(codebase.default_cwd),
            codebase.default_branch ? toBranchName(codebase.default_branch) : undefined
          );
          getLog().debug(
            {
              codebaseId: codebase.id,
              repoPath: codebase.default_cwd,
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

/** Build the user-facing prompt with message and optional contexts */
function buildFullPrompt(
  message: string,
  issueContext: string | undefined,
  threadContext: string | undefined,
  attachedFiles?: AttachedFile[],
  workflowContext?: string
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

  if (threadContext) {
    return (
      '## Thread Context (previous messages)\n\n' +
      threadContext +
      workflowContextSuffix +
      '\n\n---\n\n## Current Request\n\n' +
      message +
      contextSuffix +
      fileSuffix
    );
  }

  return (
    workflowContextSuffix + '\n\n---\n\n## User Message\n\n' + message + contextSuffix + fileSuffix
  );
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
  const {
    issueContext,
    threadContext,
    parentConversationId,
    isolationHints,
    attachedFiles,
    userId,
  } = context ?? {};
  try {
    getLog().debug({ conversationId, userId }, 'orchestrator_message_received');

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
          // Anonymous telemetry: NL approval path inlines the approve logic
          // (does not go through approveWorkflow), so capture here too.
          captureApprovalResolved({ resolution: 'approved' });
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
          const workflowSource = workflow
            ? discoveredWorkflows.find(w => w.workflow === workflow)?.source
            : undefined;
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
            isolationHints,
            userId,
            workflowSource
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
        'setproject',
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

        if (command === 'setproject') {
          getLog().debug({ command, conversationId }, 'deterministic_command');
          const result = await handleSetProject(message, conversationId);
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
            isolationHints,
            userId
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
    } else if (syncResult?.state === 'diverged' && platform.sendStructuredEvent) {
      await platform.sendStructuredEvent(conversationId, {
        type: 'system',
        content: `Local source/ has diverged from origin/${syncResult.branch} \u2014 manual merge or rebase needed`,
      });
    } else if (
      syncResult?.state === 'in_sync' &&
      syncResult.updated &&
      platform.sendStructuredEvent
    ) {
      await platform.sendStructuredEvent(conversationId, {
        type: 'system',
        content: `Fast-forwarded to origin/${syncResult.branch} \u2014 ${syncResult.previousHead} \u2192 ${syncResult.newHead}`,
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

    const fullPrompt = buildFullPrompt(
      message,
      issueContext,
      threadContext,
      attachedFiles,
      workflowContext
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
    const chatRequest = resolveModelRequest(aiProfile, 'large', configuredProviderKey);
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
    // Per-user AI-provider credentials (Phase 2): env-only delivery in direct
    // chat — there's no per-call artifacts directory, so deliveries that need
    // file writes (Codex `CODEX_HOME/auth.json` for the ChatGPT subscription
    // path) are dropped here and only apply to workflow runs. Merged LAST so
    // a connected user's keys win over file/db env. No-op when the feature is
    // disabled or no execution identity resolved (sender, else creator).
    const userProviderEnv =
      isPerUserProviderKeysEnabled() && executionUserId
        ? await resolveUserProviderEnvForChat(executionUserId)
        : {};
    const effectiveEnv = { ...(config.envVars ?? {}), ...dbEnvVars, ...userProviderEnv };

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

    // Claude supports the preset object for prompt caching; other providers
    // need a plain string (Pi coerces non-string to undefined, Codex ignores it).
    let systemAppend = buildOrchestratorSystemAppend(conversation, codebases, workflows);
    // Capabilities are only consulted for project-scoped chats (both the native tool
    // and the CLI pointer are scoped features), so look them up lazily — this also
    // avoids a registry lookup (and a throw for an unregistered provider) on the
    // unscoped path.
    const scopedCaps =
      conversation.codebase_id !== null ? getProviderCapabilities(providerKey) : null;
    // Providers WITHOUT the in-process manage_run tool (Codex/OpenCode/Copilot) get a
    // system-prompt pointer to the `archon workflow …` CLI so they can still manage this
    // project's runs over bash. Claude/Pi get the native tool below and are nudged to it
    // — adding the CLI pointer there would be redundant and steer them onto a bash path
    // that needs `archon` on PATH. Project-scoped only: the CLI commands require a
    // git-repo cwd, which unscoped chats (cwd ~/.archon/workspaces) don't have.
    if (scopedCaps !== null && !scopedCaps.nativeTools) {
      systemAppend += `\n\n${buildRunManagementSection()}`;
    }
    const systemPrompt =
      providerKey === 'claude'
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemAppend }
        : systemAppend;

    const requestOptions: SendQueryOptions = {
      assistantConfig: { ...(config.assistants[providerKey] ?? {}) },
      env: Object.keys(effectiveEnv).length > 0 ? effectiveEnv : undefined,
      model: chatRequest.model,
      systemPrompt,
    };
    if (chatRequest.preset) {
      applyPresetToRequestOptions(providerKey, chatRequest.preset, requestOptions);
    }

    if (!conversation.title && !message.startsWith('/')) {
      const titleRequest = resolveModelRequest(aiProfile, 'small', configuredProviderKey);
      const titleOptions: SendQueryOptions = {
        model: titleRequest.model,
        assistantConfig: { ...(config.assistants[titleRequest.provider] ?? {}) },
      };
      if (titleRequest.preset) {
        applyPresetToRequestOptions(titleRequest.provider, titleRequest.preset, titleOptions);
      }
      void generateAndSetTitle(
        conversation.id,
        message,
        titleRequest.provider,
        cwd,
        undefined,
        titleOptions.assistantConfig,
        titleOptions
      );
    }

    // 5. Send to AI provider
    const aiClient = getAgentProvider(providerKey);
    getLog().debug(
      { assistantType: conversation.ai_assistant_type, resolvedAssistantType: providerKey },
      'sending_to_ai'
    );

    // Project-scoped chats get the `manage_run` tool so the agent can see and
    // launch this project's workflow runs. Only when a codebase is scoped and
    // the provider supports in-process native tools (Claude, Pi). The explicit
    // codebase_id check (redundant with scopedCaps !== null) narrows it to string
    // for the block below.
    if (conversation.codebase_id !== null && scopedCaps?.nativeTools) {
      const scopedCodebaseId = conversation.codebase_id;
      requestOptions.nativeTools = [
        buildManageRunTool({
          codebaseId: scopedCodebaseId,
          startWorkflow: async (workflowName, msg): Promise<string> => {
            let wf: WorkflowDefinition | undefined;
            try {
              wf = resolveWorkflowName(workflowName, workflows);
            } catch (e: unknown) {
              return toError(e).message; // ambiguous-name error is user-facing
            }
            if (wf === undefined) {
              const names = workflows.map(w => w.name).join(', ');
              return `No workflow named "${workflowName}". Available: ${names}`;
            }
            try {
              await dispatchBackgroundWorkflow(
                {
                  platform,
                  conversationId,
                  cwd,
                  originalMessage: msg.length > 0 ? msg : `Run ${wf.name}`,
                  conversationDbId: conversation.id,
                  codebaseId: scopedCodebaseId,
                  availableWorkflows: workflows,
                  userId,
                },
                wf
              );
            } catch (e: unknown) {
              const err = toError(e);
              getLog().error(
                { err, workflow: wf.name, codebaseId: scopedCodebaseId, conversationId },
                'manage_run.start_failed'
              );
              return `Failed to start workflow "${wf.name}": ${err.message}`;
            }
            return `Started workflow "${wf.name}" in the background — it'll appear in the runs list and the workflow dock shortly.`;
          },
        }),
      ];
    }

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
        requestOptions,
        userId
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
        requestOptions,
        userId
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
  requestOptions?: SendQueryOptions,
  userId?: string
): Promise<void> {
  const turnStartedAt = Date.now();
  const allMessages: string[] = [];
  let newSessionId: string | undefined;
  let commandDetected = false;
  let commandFullyParsed = false;
  let lastResult: { cost?: number; tokens?: TokenUsage; stopReason?: string } | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    requestOptions
  )) {
    if (msg.type === 'assistant' && msg.content) {
      // Accumulate only while the command is not yet fully captured; post-command
      // trailing chunks would corrupt the project-name token if joined without a
      // whitespace boundary, causing the parse regex to overshoot.
      if (!commandFullyParsed) {
        allMessages.push(msg.content);
      }
      if (!commandDetected) {
        // Check for orchestrator commands BEFORE streaming to frontend.
        // If detected, suppress this chunk and all future chunks — the full
        // response will be parsed post-loop and the command dispatched there.
        const accumulated = allMessages.join('');
        const normalizedAccumulated = normalizeCommandText(accumulated);
        if (
          INVOKE_WORKFLOW_PREFIX_RE.test(normalizedAccumulated) ||
          REGISTER_PROJECT_PREFIX_RE.test(normalizedAccumulated)
        ) {
          commandDetected = true;
          // If the complete command pattern is already present, stop accumulating —
          // no more chunks needed. This prevents trailing chunks from corrupting
          // the project-name token when the command was fully emitted in one chunk.
          if (isCommandFullyParsed(accumulated)) {
            commandFullyParsed = true;
          }
        } else {
          await platform.sendMessage(conversationId, msg.content);
        }
      } else if (!commandFullyParsed) {
        // Post-prefix: keep accumulating until the full command pattern is present.
        const accumulated = allMessages.join('');
        if (isCommandFullyParsed(accumulated)) {
          commandFullyParsed = true;
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
    } else if (msg.type === 'result') {
      if (msg.isError && msg.errorSubtype === 'error_during_execution') {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            staleSessionId: msg.sessionId,
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
      if (msg.isError && msg.errorSubtype !== 'success') {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            errors: msg.errors,
            stopReason: msg.stopReason,
          },
          'ai_result_error'
        );
        const syntheticError = new Error(msg.errorSubtype ?? 'AI result error');
        await platform.sendMessage(conversationId, classifyAndFormatError(syntheticError));
        if (newSessionId) {
          await tryPersistSessionId(session.id, newSessionId);
        }
        // Anonymous telemetry: AI returned an error result for this chat turn.
        captureChatTurn({
          platform: platform.getPlatformType(),
          provider: aiClient.getType(),
          model: requestOptions?.model,
          durationMs: Date.now() - turnStartedAt,
          outcome: 'failed',
        });
        return;
      }
      if (!commandDetected && platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
      lastResult = {
        cost: msg.cost,
        tokens: msg.tokens,
        stopReason: msg.stopReason,
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
      issueContext,
      userId
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
  await maybeSendResultFooter(platform, conversationId, lastResult);
  // Anonymous telemetry: one completed direct-chat turn. The workflow-invocation
  // and project-registration paths return above without reaching this — those
  // are covered by workflow_invoked / codebase_registered instead. Platform +
  // provider only, never message content.
  captureChatTurn({
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions?.model,
    // durationMs deliberately measures from mode-handler entry — it includes
    // pre-AI setup, i.e. "time the user waited", not pure model latency.
    durationMs: Date.now() - turnStartedAt,
    costUsd: lastResult?.cost,
    tokensIn: lastResult?.tokens?.input,
    tokensOut: lastResult?.tokens?.output,
    outcome: 'completed',
  });
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
  requestOptions?: SendQueryOptions,
  userId?: string
): Promise<void> {
  const turnStartedAt = Date.now();
  const allChunks: { type: string; content: string }[] = [];
  const assistantMessages: string[] = [];
  let assistantChunksTruncated = false;
  let totalChunksTruncated = false;
  let newSessionId: string | undefined;
  let commandDetected = false;
  let commandFullyParsed = false;
  let lastResult: { cost?: number; tokens?: TokenUsage; stopReason?: string } | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    requestOptions
  )) {
    if (msg.type === 'assistant' && msg.content) {
      // Always record in allChunks for debug logging; accumulate assistantMessages
      // only while the command is not yet fully captured (same reason as stream mode).
      allChunks.push({ type: 'assistant', content: msg.content });
      if (!commandFullyParsed) {
        assistantMessages.push(msg.content);
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
        const normalizedAccumulated = normalizeCommandText(accumulated);
        if (
          INVOKE_WORKFLOW_PREFIX_RE.test(normalizedAccumulated) ||
          REGISTER_PROJECT_PREFIX_RE.test(normalizedAccumulated)
        ) {
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
    } else if (msg.type === 'tool' && msg.toolName) {
      if (!commandDetected) {
        const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
        allChunks.push({ type: 'tool', content: toolMessage });
        getLog().debug({ toolName: msg.toolName }, 'tool_call');
      }
    } else if (msg.type === 'result') {
      if (msg.isError && msg.errorSubtype === 'error_during_execution') {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            staleSessionId: msg.sessionId,
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
      if (msg.isError && msg.errorSubtype !== 'success') {
        getLog().warn(
          {
            conversationId,
            errorSubtype: msg.errorSubtype,
            errors: msg.errors,
            stopReason: msg.stopReason,
          },
          'ai_result_error'
        );
        const syntheticError = new Error(msg.errorSubtype ?? 'AI result error');
        await platform.sendMessage(conversationId, classifyAndFormatError(syntheticError));
        if (newSessionId) {
          await tryPersistSessionId(session.id, newSessionId);
        }
        // Anonymous telemetry: AI returned an error result for this chat turn.
        captureChatTurn({
          platform: platform.getPlatformType(),
          provider: aiClient.getType(),
          model: requestOptions?.model,
          durationMs: Date.now() - turnStartedAt,
          outcome: 'failed',
        });
        return;
      }
      lastResult = {
        cost: msg.cost,
        tokens: msg.tokens,
        stopReason: msg.stopReason,
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
  const commands = parseOrchestratorCommands(assistantMessages.join(''), codebases, workflows);

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
      issueContext,
      userId
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
  await maybeSendResultFooter(platform, conversationId, lastResult);
  // Anonymous telemetry: one completed direct-chat turn (same exclusion
  // rationale as the stream-mode capture in handleStreamMode above).
  captureChatTurn({
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions?.model,
    // durationMs deliberately measures from mode-handler entry — it includes
    // pre-AI setup, i.e. "time the user waited", not pure model latency.
    durationMs: Date.now() - turnStartedAt,
    costUsd: lastResult?.cost,
    tokensIn: lastResult?.tokens?.input,
    tokensOut: lastResult?.tokens?.output,
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
  workflows: readonly WorkflowDefinition[],
  invocation: WorkflowInvocation,
  originalMessage: string,
  isolationHints: HandleMessageContext['isolationHints'],
  issueContext?: string,
  userId?: string
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
      isolationHints,
      userId
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
  const detectedBranch = await detectCurrentGitBranch(projectPath);
  const codebase = await codebaseDb.createCodebase({
    name: projectName,
    default_cwd: projectPath,
    default_branch: detectedBranch,
    ai_assistant_type: config.assistant,
  });

  getLog().info(
    { name: projectName, path: projectPath, id: codebase.id },
    'project.register_completed'
  );
  return `Project "${projectName}" registered successfully!\nPath: ${projectPath}\nID: ${codebase.id}`;
}

async function detectCurrentGitBranch(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 }
    );
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
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
  } catch (err) {
    getLog().warn({ err: err as Error, codebaseId: codebase.id, newPath }, 'project.update_failed');
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
 * Handle /setproject command.
 * Binds the current conversation to a registered codebase by writing
 * `codebase_id` and `cwd` to the conversations table. Uses 4-tier fuzzy
 * name resolution (exact → case-insensitive → prefix → substring).
 */
async function handleSetProject(message: string, conversationId: string): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 1) {
    return 'Usage: /setproject <project-name>';
  }

  const projectName = args.join(' ');
  const codebases = await codebaseDb.listCodebases();

  let codebase: Codebase | undefined;
  try {
    codebase = resolveCodebaseName(projectName, codebases);
  } catch (err) {
    return (err as Error).message;
  }

  if (!codebase) {
    const available = codebases.map(c => c.name).join(', ');
    return available
      ? `Project "${projectName}" not found.\nRegistered projects: ${available}`
      : `Project "${projectName}" not found. No projects registered — use /register-project.`;
  }

  await db.updateConversation(conversationId, {
    codebase_id: codebase.id,
    cwd: codebase.default_cwd,
  });

  getLog().info(
    { conversationId, projectName: codebase.name, codebaseId: codebase.id },
    'project.set_completed'
  );
  return `Project set to **${codebase.name}**\nWorking directory: ${codebase.default_cwd}`;
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
  isolationHints?: HandleMessageContext['isolationHints'],
  userId?: string
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
      isolationHints,
      userId
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
      isolationHints,
      userId,
      resolvedEntry?.source
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
