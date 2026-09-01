/**
 * Orchestrator Agent - Main entry point for AI-powered message routing
 *
 * Single entry point for all platforms:
 * - Knows all registered projects and workflows upfront
 * - Can answer directly or invoke workflows
 * - Does NOT require a project to be selected before starting a conversation
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import { createLogger, captureChatTurn, canonicalizeProjectPath } from '@archon/paths';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  AttachedFile,
} from '../types';
import type { SendQueryOptions, TokenUsage } from '@archon/providers/types';
import { ConversationNotFoundError, isWebAdapter } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '@archon/workflows/utils/tool-formatter';
import { classifyAndFormatError } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { safeDeactivateSession } from '../state/session-transitions';
import { getAgentProvider, getProviderCapabilities } from '@archon/providers';
import { buildManageRunTool } from './manage-run-tool';
import { getArchonWorkspacesPath, ensureArchonWorkspacesPath } from '@archon/paths';
import { resolveWorkflowSourceRoot } from '../utils/workflow-source-root';
import {
  execFileAsync,
  findRepoRoot,
  getDefaultRemote,
  syncWorkspace,
  toBranchName,
  toRepoPath,
} from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow, resolveWorkflowName } from '@archon/workflows/router';
import {
  executeWorkflow,
  resolveContinuationWorkflow,
  withCapturedSource,
  type CapturedSourceOwner,
  hydrateResumableRun,
  inspectResumableRun,
  prepareWorkflowSource,
  recordSelectedWorkflow,
  type PreparedWorkflowSource,
} from '@archon/workflows/executor';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { liveSourceRoots } from '@archon/workflows/workflow-discovery';
import {
  assertWorkflowRequirementsMet,
  WorkflowRequirementError,
  ComposedApprovalGateError,
  resolveTopLevelInputs,
  WorkflowMissingInputsError,
} from '@archon/workflows/utils/workflow-requirements';
import { WorkflowInputContractError } from '@archon/workflows/workflow-inputs';
import { formatDeprecationNotice } from '@archon/workflows/deprecation';
import type {
  ResolvedWorkflow,
  WorkflowDefinition,
  WorkflowWithSource,
  WorkflowLoadError,
  WorkflowSource,
} from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { getDecryptedAccessToken } from '../db/user-github-token-store';
import { isPerUserProviderKeysEnabled } from '../credentials/config';
import { deliverCredential } from '../credentials/delivery';
import { listDecryptedUserProviderCredentials } from '../db/user-provider-key-store';
import { getUserAiPrefs, type UserAiPrefs } from '../db/user-ai-prefs-store';
import { createWorkflowDeps } from '../workflows/store-adapter';
import { createChildWorktreeResolver } from '../workflows/child-isolation-resolver';
import { resolveWorkflowAdoption, WorkflowAdoptionError } from '../operations/workflow-adoption';
import { loadConfig, loadRepoConfig } from '../config/config-loader';
import type { MergedConfig } from '../config/config-types';
import { generateAndSetTitle } from '../services/title-generator';
import { validateAndResolveIsolation, dispatchBackgroundWorkflow } from './orchestrator';
import { IsolationBlockedError } from '@archon/isolation';
import {
  buildOrchestratorSystemAppend,
  buildRunManagementSection,
  formatPausedGateSection,
  formatWorkflowContextSection,
} from './prompt-builder';
import type { WorkflowResultContext } from './prompt-builder';
import { reportUnpushedWorkInSource } from './post-message-reminder';
import * as messageDb from '../db/messages';
import * as workflowDb from '../db/workflows';
import { getCodebaseEnvVars } from '../db/env-vars';
import {
  buildAiProfile,
  isLiteralSpec,
  isTierName,
  resolveModelSpec,
  resolveTierWithFallback,
  resolvePresetEffort,
  type ModelAliasPreset,
  type RunModelOverrides,
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
  if (preset.effort === undefined) return;

  // One effort channel for every provider (#2556): the preset's rung goes on
  // nodeConfig and the provider clamps it into its own SDK vocabulary. The gate
  // is shared with `applyPresetOptions` in the DAG executor rather than
  // restated, so the same tier cannot mean different depths in chat and in a
  // workflow.
  const decision = resolvePresetEffort(provider, preset.effort);
  if (!decision.ok) {
    // `unsupported` = the provider has no reasoning control at all. Warn instead
    // of silently dropping.
    getLog().warn(
      { provider, effort: preset.effort, valid: decision.valid },
      decision.reason === 'unsupported'
        ? 'orchestrator.preset_effort_unsupported'
        : 'orchestrator.preset_effort_unknown'
    );
    return;
  }
  options.nodeConfig = { ...(options.nodeConfig ?? {}), effort: preset.effort };
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

/**
 * Resolve the model request for the MAIN chat turn (#1998).
 *
 * Model precedence (chat call-site only — workflows keep resolving `large`):
 *   1. per-user `default_model` — applied only when the user's
 *      `default_provider` matches the effective provider (a stale pin must
 *      never ride a different provider). Routed through resolveModelRequest so
 *      `@alias` and tier refs keep working; an unresolvable ref (e.g. deleted
 *      alias) degrades to the tier path with a warning instead of failing chat.
 *   2. tier `large` from CONFIGURED tiers (user > repo > global).
 *   3. install `assistants.<p>.model` — outranks the BUILT-IN tier default
 *      only, never a configured tier ('inherit' means "SDK default", skip).
 *   4. built-in tier default.
 *
 * Title generation is NOT routed through this — it keeps the `small` tier.
 * With no user prefs and no `assistants.<p>.model`, this reduces byte-for-byte
 * to the previous `resolveModelRequest(aiProfile, 'large', provider)` call.
 * Exported for tests.
 */
export function resolveChatModelRequest(
  aiProfile: ReturnType<typeof buildAiProfile>,
  configuredProviderKey: string,
  userAiPrefs: UserAiPrefs,
  config: Pick<MergedConfig, 'assistants' | 'tiers'>
): ResolvedModelRequest {
  if (
    userAiPrefs.defaultModel !== undefined &&
    userAiPrefs.defaultProvider === configuredProviderKey
  ) {
    try {
      return resolveModelRequest(aiProfile, userAiPrefs.defaultModel, configuredProviderKey);
    } catch (err) {
      getLog().warn(
        { err: err as Error, defaultModel: userAiPrefs.defaultModel },
        'orchestrator.user_default_model_invalid'
      );
    }
  }
  const request = resolveModelRequest(aiProfile, 'large', configuredProviderKey);
  if (request.matchedTier === undefined) return request;

  const tierConfigured =
    config.tiers?.[request.matchedTier] !== undefined ||
    userAiPrefs.tiers?.[request.matchedTier] !== undefined;
  if (tierConfigured) return request;

  const installModel = config.assistants[request.provider]?.model;
  if (typeof installModel === 'string' && installModel !== '' && installModel !== 'inherit') {
    return { ...request, model: installModel };
  }
  return request;
}

/** A resolved title-generation request: which provider to call, with fully resolved options. */
export interface TitleRequest {
  provider: string;
  options: SendQueryOptions;
}

/**
 * Resolve provider + request options for conversation-title generation (#1855).
 *
 * Server entry points that fire title generation outside a full chat turn
 * (create-with-message, web workflow run) resolve the `small` tier here —
 * config tiers plus per-user prefs when a userId is available — instead of
 * letting the provider fall through to its raw config-default model, which
 * the active account may not support (e.g. `gpt-5.3-codex` on ChatGPT-plan
 * Codex accounts). Mirrors the chat path's title resolution in
 * `handleMessage` (#1873), which keeps its own inline resolution to reuse
 * the already-loaded config and profile.
 *
 * NEVER THROWS — degrades to `{ provider: fallbackProvider, options: {} }`
 * (the legacy behavior) so fire-and-forget callers stay safe.
 */
export async function resolveTitleRequest(
  fallbackProvider: string,
  userId?: string
): Promise<TitleRequest> {
  try {
    const config = await loadConfig();
    const userAiPrefs = userId ? await resolveUserAiPrefsForChat(userId) : {};
    let configuredProviderKey = userAiPrefs.defaultProvider ?? fallbackProvider;
    let aiProfile: ReturnType<typeof buildAiProfile>;
    try {
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
        userTiers: userAiPrefs.tiers,
        userAliases: userAiPrefs.aliases,
      });
    } catch (profileErr) {
      // Structurally invalid STORED prefs must not break title generation —
      // degrade to config-only (mirrors the chat path in handleMessage).
      getLog().warn({ err: profileErr as Error, userId }, 'orchestrator.title_prefs_invalid');
      configuredProviderKey = fallbackProvider;
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
      });
    }
    const titleRequest = resolveModelRequest(aiProfile, 'small', configuredProviderKey);
    const options: SendQueryOptions = {
      model: titleRequest.model,
      assistantConfig: { ...(config.assistants[titleRequest.provider] ?? {}) },
    };
    if (titleRequest.preset) {
      applyPresetToRequestOptions(titleRequest.provider, titleRequest.preset, options);
    }
    return { provider: titleRequest.provider, options };
  } catch (err) {
    getLog().warn(
      { err: err as Error, fallbackProvider },
      'orchestrator.title_request_resolve_failed'
    );
    return { provider: fallbackProvider, options: {} };
  }
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
  workflows: readonly Pick<WorkflowDefinition, 'name'>[]
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

interface WorkflowDispatchOptions {
  force?: boolean;
  resumeRunId?: string;
  resumeRun?: WorkflowRun;
  /**
   * The continuation graph a caller already resolved from the run's recorded source.
   *
   * `command-handler` resolves it to build its `CommandResult`, which costs a digest read
   * and a full discovery; without passing it here that work happened twice on every
   * resume, approve and reject. A value rather than an "already done" flag, so it cannot
   * claim something it does not carry.
   */
  resolvedContinuation?: ResolvedWorkflow;
  /**
   * Keys the engine dropped from the workflow's YAML (#2213). Mirrored into the
   * conversation before the run starts — chat and the console are where most
   * runs are STARTED, so a warning that only reaches the CLI misses the moment
   * of consequence.
   *
   * Deliberately unset on every resume path: delivery happens at most ONCE, at
   * the run's original chat/console start. That is not the same as "the warning
   * already fired" — delivery lives only in `dispatchOrchestratorWorkflow`, so a
   * run started by `archon workflow run` (which warns on stderr instead) and
   * later resumed with `/workflow resume` in chat never produced a chat warning,
   * and neither did any run predating this feature. Resuming does not re-derive
   * one; the author's durable surfaces are `validate`, `list` and the console
   * picker.
   */
  parseWarnings?: readonly string[];
  /**
   * Declared inputs supplied by the caller (#2554), already carried this far by
   * `HandleMessageContext.workflowInputs`. Populated only by the run route; chat
   * platforms have no channel and leave it unset, so their behaviour is unchanged.
   * Validated at the dispatch gate before any worktree/clone/AI cost.
   */
  inputs?: Readonly<Record<string, string>>;
  /** Sparse tier/@alias rebindings supplied by this run invocation (#2481). */
  modelOverrides?: RunModelOverrides;
  /** Validated sparse config content supplied by a fresh HTTP invocation. */
  runConfig?: WorkflowRunConfigInput;
  /** Between-run continuation (#2747): adopt/supersede target, if declared. */
  adoptRunId?: string;
  supersedesRunId?: string;
}

const FAILED_RUN_PROMPT_PREVIEW_MAX = 160;

function escapeWorkflowCommandArg(value: string): string {
  return value.replace(/[\\"`]/g, '\\$&');
}

function formatPriorRunPromptPreview(message: string | null): string {
  const normalized = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no message stored)';
  }
  if (normalized.length <= FAILED_RUN_PROMPT_PREVIEW_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, FAILED_RUN_PROMPT_PREVIEW_MAX)}…`;
}

function formatResumableRunState(status: WorkflowRun['status']): string {
  return status === 'running' ? 'interrupted' : status;
}

function buildFailedRunResumePrompt(
  workflowName: string,
  resumableRun: WorkflowRun,
  userMessage: string
): string {
  const escapedMessage = escapeWorkflowCommandArg(userMessage);
  const baseCommand = `/workflow run ${workflowName}`;
  const priorPreview = formatPriorRunPromptPreview(resumableRun.user_message);
  // This prompt fires for any non-paused resumable run — that includes a stale
  // 'running' orphan (started but never finished), not only 'failed' runs, so
  // the wording must track the actual status rather than hardcoding "failed".
  const stateLabel = formatResumableRunState(resumableRun.status);

  return [
    '---',
    '',
    `Found a prior ${stateLabel} run of **${workflowName}** (run \`${resumableRun.id}\`).`,
    '',
    '**Run prompt was:**',
    '',
    `> ${priorPreview}`,
    '',
    '---',
    '',
    '**Choose how to proceed:**',
    '',
    '**1. Resume that run** (re-runs the prompt shown above, not your current message):',
    '```',
    `/workflow resume ${resumableRun.id}`,
    '```',
    '',
    `**2. Discard the ${stateLabel} run, then start fresh with your current message:**`,
    '```',
    `/workflow abandon ${resumableRun.id}`,
    '```',
    'then re-run your command:',
    '```',
    `${baseCommand} "${escapedMessage}"`,
    '```',
    '',
    `**3. Start fresh with your current message, leave the ${stateLabel} run as-is** (skips the resume check):`,
    '```',
    `${baseCommand} --force "${escapedMessage}"`,
    '```',
  ].join('\n');
}

/**
 * Dispatch a workflow after the orchestrator resolves a project.
 * Auto-attaches the project to the conversation, resolves isolation, and executes.
 *
 * TODO(#988): Move to operations/ once dispatchBackgroundWorkflow is extracted
 * from the orchestrator (currently coupled to SSE bridging infrastructure).
 */
async function dispatchOrchestratorWorkflowOwned(
  owner: CapturedSourceOwner,
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  workflow: ResolvedWorkflow,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints'],
  userId?: string,
  /**
   * Discovery source of the workflow — telemetry only (bundled workflows
   * report their real name, custom ones report "custom"). Optional: callers
   * that don't have it readily in scope omit it and the run reports "custom".
   */
  source?: WorkflowSource,
  options?: WorkflowDispatchOptions
): Promise<void> {
  // The codebase's stored default branch — the $BASE_BRANCH fallback for every
  // executeWorkflow dispatch below (repo config worktree.baseBranch still wins).
  const codebaseBaseBranch = codebase.default_branch?.trim() || undefined;

  // Between-run continuation (#2747): adoption is validated by the ONE resolver,
  // whatever surface declared it — CLI, API, or chat. A non-terminal target, a
  // cross-codebase id, or a missing estate refuses here, before any worktree is
  // cut; the resolved lane then drives where the run actually executes.
  const adoptionLane = options?.adoptRunId
    ? (
        await resolveWorkflowAdoption({
          adoptedRunId: options.adoptRunId,
          codebaseId: codebase.id,
          codebasePath: codebase.default_cwd,
          codebaseKind: codebase.kind,
        })
      ).lane
    : undefined;

  // A lane other than in-place inherits a worktree or branch estate; a workflow
  // that opted out of worktrees runs in the parent checkout and has nothing to
  // inherit, so honoring the adoption would mean silently dropping the lane.
  if (
    options?.adoptRunId !== undefined &&
    adoptionLane !== undefined &&
    adoptionLane.kind !== 'in-place' &&
    workflow.worktree?.enabled === false
  ) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${options.adoptRunId}': workflow '${workflow.name}' disables ` +
        'worktrees, so there is no worktree or branch estate to inherit. ' +
        'Drop the adoption or run a worktree-isolated workflow.'
    );
  }

  // Per-child isolation resolver (#2121 slice 2, PR-A): a `workflow:` node with
  // `isolation: 'worktree'` gets its own worktree per child. Built for git-repo
  // codebases only — a folder project can't make worktrees, so the engine fails
  // such a node fast (no resolver injected). Shared across every dispatch below.
  const resolveChildIsolation =
    codebase.kind !== 'folder'
      ? createChildWorktreeResolver({
          codebaseId: codebase.id,
          codebaseName: codebase.name,
          canonicalRepoPath: codebase.default_cwd,
          baseBranch: codebaseBaseBranch,
          createdByPlatform: platform.getPlatformType(),
          createdByUserId: userId,
        })
      : undefined;

  // Resume detection, hoisted above the signature gate ON PURPOSE (#2554).
  //
  // This function continues an existing run in TWO ways: an explicit
  // `/workflow resume <id>` (which arrives as `resumeRunId`/`resumeRun`), and an
  // IMPLICIT auto-detection that fires for a plain `/workflow run <name>` on every
  // platform — the lookup that used to live further down, next to the dispatch. The
  // gate below has to know about both: gating only against the explicit form wrongly
  // refused a required-input workflow that was merely being continued (the run row
  // already holds its validated inputs, and the caller supplies nothing when they
  // just say "run it" again).
  //
  // It has to be hoisted rather than the gate pushed down: `validateAndResolveIsolation`
  // sits between here and the old lookup site and CREATES WORKTREES, so gating after it
  // would forfeit the pre-cost refusal. This lookup is a single indexed DB read — no
  // worktree, no clone, no AI — so it is safe to do before gating. Its inputs
  // (`conversation.id`, `codebase.id`) are parameters and nothing below mutates them.
  const resumableRun = options?.force
    ? null
    : (options?.resumeRun ??
      (await workflowDb.findResumableRunByParentConversation(
        workflow.name,
        conversation.id,
        codebase.id
      )));
  // Whether this dispatch will CONTINUE existing work rather than create a fresh run
  // row. Deliberately the exact negation of the resume/abandon/force menu's condition
  // below: a candidate that is neither paused nor the explicitly-targeted run does not
  // continue — it shows that menu and returns. Only a genuine continuation may defer the
  // signature gate, so an invocation that was never going to continue is still refused
  // immediately, with the specific input error rather than a generic menu, and before
  // isolation resolution can create a worktree.
  //
  // It does NOT mirror the other refusal exit below — an explicit resume naming a run
  // with no `working_path` is now preempted by the gate instead of reaching that check.
  // That is a behaviour change and it is deliberate. Every row-creation site records a
  // real `working_path`, so a NULL one means a row predating the column; reaching the
  // gate with a violation to defer additionally needs that ancient run's workflow to
  // have since gained a required input, and someone to resume it explicitly. (The gate
  // judges the CURRENT YAML, not the row's vintage, so that combination is improbable
  // rather than impossible.) Both exits refuse at zero cost, so which message wins is a
  // wording question, not a correctness one.
  const willContinueExistingRun =
    Boolean(resumableRun?.working_path) &&
    (resumableRun?.status === 'paused' || resumableRun?.id === options?.resumeRunId);

  // Adoption and continuation are mutually exclusive: both decide where the run
  // executes and which estate it inherits, and every continuation path below forwards
  // only the resume context — an adopted id would be validated above and then silently
  // dropped. Refuse the combination up front, mirroring the CLI's adopt/resume guard.
  if (options?.adoptRunId !== undefined && willContinueExistingRun && resumableRun) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${options.adoptRunId}': this conversation already continues ` +
        `run '${resumableRun.id}' (${resumableRun.status}). Resume or abandon that run ` +
        'first, or declare the adoption from a conversation with no open run.'
    );
  }

  // ── Executable source ───────────────────────────────────────────────────────
  //
  // AFTER resume detection, on purpose. A continuation must execute the source its run
  // already froze; capturing here would freeze current bytes, re-resolve the graph from
  // them, and then hand the executor a run whose recorded capture supplies the commands
  // and scripts — a graph from one moment against resources from another. Capturing a
  // resume also leaves a staging directory nothing adopts.
  //
  // For a fresh run: freeze, then re-resolve the workflow FROM the frozen copy, so the
  // definition executed and the resources beside it are one consistent set of bytes.
  const runCwd = conversation.cwd ?? codebase.default_cwd;
  // `preparedSource` is the outer binding the resume branch reads (always undefined
  // there — step 2 didn't run for a continuation). The two fresh dispatches read
  // `freshCaptured` directly, so the helper's narrowed return type survives.
  let preparedSource: PreparedWorkflowSource | undefined;
  let freshCaptured:
    | { preparedSource: PreparedWorkflowSource; workflow: ResolvedWorkflow }
    | undefined;

  if (willContinueExistingRun && resumableRun) {
    // Continuing: execute the GRAPH this run froze, not the one on disk now. Skipping
    // this left the DAG live while the executor fed it commands and scripts from the old
    // capture — an edited workflow would silently run its new graph against pre-edit
    // command bytes. Undefined means a run predating capture, which keeps live behavior.
    try {
      if (options?.resolvedContinuation) {
        workflow = options.resolvedContinuation;
      } else {
        const continuation = await resolveContinuationWorkflow(
          createWorkflowDeps(),
          resumableRun,
          runCwd
        );
        if (continuation) workflow = continuation.workflow;
      }
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, runId: resumableRun.id }, 'workflow.continuation_source_failed');
      await platform.sendMessage(
        conversationId,
        `Cannot continue run \`${resumableRun.id}\`: ${err.message} ` +
          'Start a fresh run to execute the current workflow.'
      );
      return;
    }
  }

  // A reuse-worktree lane inherits the adopted run's worktree; its `.archon` belongs to
  // whatever branch that worktree carries, so the frozen source must come from THERE —
  // capturing from the parent checkout would mix vintages exactly as #2660 describes.
  // A checkout-branch lane has the same constraint, but its worktree only exists after
  // isolation resolution below — so its capture is deferred until `cwd` is known.
  const captureCwd = adoptionLane?.kind === 'reuse-worktree' ? adoptionLane.workingPath : runCwd;
  if (!willContinueExistingRun && adoptionLane?.kind !== 'checkout-branch') {
    freshCaptured = await captureFreshSource(
      owner,
      captureCwd,
      workflow,
      conversationId,
      platform,
      adoptionLane?.kind === 'reuse-worktree' ? captureCwd : undefined
    );
    if (!freshCaptured) return; // capture failed, message already sent
    workflow = freshCaptured.workflow;
  }

  let resolvedInputs: Record<string, string> | undefined;
  // A contract violation held back because a resume may make it moot. Only the one
  // branch below that falls through to a FRESH run row (hydration found nothing worth
  // resuming) still needs it; every other continuation path never reads inputs from
  // this invocation at all.
  let deferredInputError: Error | undefined;

  // Input signature gate (#2470, #2554) plus capability gate, judged against ONE
  // workflow definition. A checkout-branch adoption swaps the definition for the
  // branch's vintage only after isolation resolves its worktree, so these gates must
  // run AFTER that swap there — otherwise required inputs or `requires:` declared on
  // the branch would bypass them entirely.
  const runSignatureGates = async (definition: ResolvedWorkflow): Promise<boolean> => {
    // Resolve this invocation's declared inputs from the values its channel supplied —
    // the run route's `inputs` map today; chat platforms supply nothing and so still
    // refuse a required-input workflow here. The workflow still lists/loads normally.
    try {
      resolvedInputs = resolveTopLevelInputs(definition, options?.inputs);
    } catch (err) {
      // Both are user-facing contract violations: a missing required input, and — now
      // that a caller can supply values — a key the workflow does not declare.
      if (err instanceof WorkflowMissingInputsError || err instanceof WorkflowInputContractError) {
        getLog().info(
          {
            workflowName: definition.name,
            // Names only, never values — a supplied value is user content (logging rules).
            missing: err instanceof WorkflowMissingInputsError ? err.missing : undefined,
            suppliedKeys: options?.inputs ? Object.keys(options.inputs) : [],
            deferred: willContinueExistingRun,
          },
          'workflow.required_inputs_unsatisfiable'
        );
        if (!willContinueExistingRun) {
          await platform.sendMessage(conversationId, err.message);
          return false;
        }
        deferredInputError = err;
      } else {
        throw err;
      }
    }

    // Capability gate: hard-fail before any worktree/clone/AI cost if the
    // workflow declares `requires: [github]` and the originating user hasn't
    // connected. No-op when per-user GitHub is disabled (solo PAT installs).
    if (isPerUserGitHubEnabled() && definition.requires?.length) {
      const githubConnected = userId ? Boolean(await getDecryptedAccessToken(userId)) : false;
      try {
        assertWorkflowRequirementsMet(definition, { githubConnected });
      } catch (err) {
        if (err instanceof WorkflowRequirementError) {
          getLog().info(
            { workflowName: definition.name, conversationId, userId, requirement: err.requirement },
            'workflow.requirement_unmet'
          );
          await platform.sendMessage(conversationId, err.message);
          return false;
        }
        throw err;
      }
    }
    return true;
  };

  const gatesWaitForBranchVintage =
    adoptionLane?.kind === 'checkout-branch' && !willContinueExistingRun;
  if (!gatesWaitForBranchVintage && !(await runSignatureGates(workflow))) return;

  // Keys the engine dropped from this workflow's YAML (#2213). Every chat and
  // console run funnels through here, so this is the one place that covers all
  // of them. Sent before the run starts and independently of the run's own
  // output, so it lands even when the workflow immediately backgrounds itself.
  // Best-effort: a delivery failure must not stop the run the user asked for.
  if (options?.parseWarnings && options.parseWarnings.length > 0) {
    const lines = options.parseWarnings.map(w => `- ${w}`).join('\n');
    try {
      await platform.sendMessage(
        conversationId,
        `⚠️ \`${workflow.name}\` declares keys the engine ignores:\n${lines}`
      );
    } catch (error) {
      getLog().warn(
        { err: toError(error), conversationId, workflowName: workflow.name },
        'workflow.parse_warning_delivery_failed'
      );
    }
  }

  // Deprecated bundled default (#2781). Same reach as the parse warnings above:
  // every chat and console run funnels through here, before any background split,
  // so the removal notice lands on each surface the run reports to. Derived from
  // the definition itself — a copied override in project/global `.archon`
  // (same filename) drops the marker and the notice with it. Best-effort.
  const deprecationNotice = formatDeprecationNotice(workflow);
  if (deprecationNotice) {
    try {
      await platform.sendMessage(conversationId, deprecationNotice);
    } catch (error) {
      getLog().warn(
        { err: toError(error), conversationId, workflowName: workflow.name },
        'workflow.deprecation_notice_delivery_failed'
      );
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
  if (adoptionLane?.kind === 'reuse-worktree') {
    // Adoption lane: the adopted run's worktree survives — run in it dirty-as-is
    // instead of cutting a fresh one (same shape as the background dispatch in
    // orchestrator.ts). Linking the env keeps isolation hygiene pointed at this
    // checkout.
    cwd = adoptionLane.workingPath;
    await db
      .updateConversation(conversation.id, {
        cwd,
        ...(adoptionLane.envId ? { isolation_env_id: adoptionLane.envId } : {}),
      })
      .catch((e: unknown) => {
        getLog().warn(
          { err: toError(e), conversationId },
          'orchestrator.worker_cwd_persist_failed'
        );
      });
  } else if (workflow.worktree?.enabled === false) {
    getLog().info(
      { workflowName: workflow.name, conversationId, codebaseId: codebase.id },
      'workflow.worktree_disabled_by_policy'
    );
    cwd = codebase.default_cwd;
  } else {
    try {
      const result = await validateAndResolveIsolation(
        // A checkout-branch adoption must not adopt the conversation's existing env:
        // the resolver short-circuits on `existingEnvId` before hints are read (R7), so a
        // stale worktree from an earlier run in this conversation would win over the
        // adopted branch. Null it out — same shape the `stale_cleaned` retry sees.
        {
          ...conversation,
          codebase_id: codebase.id,
          ...(adoptionLane?.kind === 'checkout-branch' ? { isolation_env_id: null } : {}),
        },
        codebase,
        platform,
        conversationId,
        adoptionLane?.kind === 'checkout-branch'
          ? {
              ...isolationHints,
              // Unique per dispatch: a shared id would key the reuse lookup to an
              // earlier adoption's worktree and drop the exact branch on later ones.
              workflowId: randomUUID(),
              workflowType: 'task',
              taskBranch: adoptionLane.taskBranch,
            }
          : isolationHints,
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

  // Deferred capture for the checkout-branch lane: the resolver materialized the
  // adopted branch, so its `.archon` is the branch's vintage — freeze it instead of
  // the parent checkout's, for the same reason the reuse-worktree lane captures above.
  if (adoptionLane?.kind === 'checkout-branch' && !willContinueExistingRun) {
    freshCaptured = await captureFreshSource(owner, cwd, workflow, conversationId, platform, cwd);
    if (!freshCaptured) return; // capture failed, message already sent
    workflow = freshCaptured.workflow;
    // The executed graph just changed vintages; judge the invocation against the
    // branch's definition, not the parent checkout's it was provisionally read from.
    if (!(await runSignatureGates(workflow))) return;
  }

  // Dispatch workflow.
  // `resumableRun` was resolved above the signature gate (see the comment there):
  // resume detection runs for ALL platforms, so a prior run for this workflow in a
  // resumable state (paused — including approved-awaiting-resume — or failed) in this
  // conversation+codebase is continued rather than dispatched fresh. This ensures chat
  // platforms (slack, telegram, discord, github) resume after approval gates just like
  // web does.
  if (options?.resumeRun && !options.resumeRun.working_path) {
    getLog().warn(
      {
        runId: options.resumeRun.id,
        workflowName: workflow.name,
        platformType: platform.getPlatformType(),
      },
      'orchestrator.resume_missing_working_path'
    );
    await platform.sendMessage(
      conversationId,
      `Cannot resume ${options.resumeRun.id}: missing working path.`
    );
    return;
  }
  if (resumableRun?.working_path) {
    if (resumableRun.status !== 'paused' && resumableRun.id !== options?.resumeRunId) {
      getLog().info(
        {
          workflowName: workflow.name,
          resumableRunId: resumableRun.id,
          platformType: platform.getPlatformType(),
        },
        'orchestrator.failed_resume_user_prompted'
      );
      await platform.sendMessage(
        conversationId,
        buildFailedRunResumePrompt(workflow.name, resumableRun, userMessage)
      );
      return;
    }

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
      if (options?.runConfig) {
        const inspection = await inspectResumableRun(deps, resumableRun);
        if (inspection) {
          await platform.sendMessage(
            conversationId,
            'This command would resume an existing run, so a new run config cannot be applied. ' +
              'Resume without config, or force a fresh run.'
          );
          return;
        }
        prepared = null;
      } else {
        prepared = await hydrateResumableRun(deps, resumableRun);
      }
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
            'No action taken — follow the existing run for progress.' +
            // The gate deferred a contract violation because this looked like a
            // continuation; losing the race means it never got surfaced anywhere else.
            // Say it here rather than let an already-computed, actionable error die.
            (deferredInputError && options?.inputs && Object.keys(options.inputs).length > 0
              ? `\n\nAlso note: ${deferredInputError.message}`
              : '')
        );
        return;
      }
      throw err;
    }
    if (prepared) {
      const resumeStateLabel = formatResumableRunState(resumableRun.status);
      const suppliedModelBindingNames = [
        ...Object.keys(options?.modelOverrides?.tiers ?? {}),
        ...Object.keys(options?.modelOverrides?.aliases ?? {}),
      ].sort();
      // A resume replays the inputs stamped on its own row; values supplied on THIS
      // call cannot reach it (the row already exists, so the executor's stamp never
      // fires). Say so rather than accepting them and quietly running something else.
      if (options?.inputs && Object.keys(options.inputs).length > 0) {
        const ignored = Object.keys(options.inputs).sort().join(', ');
        getLog().info(
          { workflowName: workflow.name, resumableRunId: resumableRun.id, ignoredKeys: ignored },
          'orchestrator.resume_ignored_supplied_inputs'
        );
        await platform.sendMessage(
          conversationId,
          `▶️ Resuming the ${resumeStateLabel} run of **${workflow.name}** (\`${resumableRun.id}\`), which ` +
            `keeps the inputs it started with — the values you supplied now (${ignored}) were ` +
            'not applied. To run fresh with them instead, abandon that run first ' +
            `(\`/workflow abandon ${resumableRun.id}\`) and re-invoke.`
        );
      }
      if (suppliedModelBindingNames.length > 0) {
        getLog().info(
          {
            workflowName: workflow.name,
            resumableRunId: resumableRun.id,
            ignoredBindings: suppliedModelBindingNames,
          },
          'orchestrator.resume_ignored_model_bindings'
        );
        await platform.sendMessage(
          conversationId,
          `▶️ Resuming the ${resumeStateLabel} run of **${workflow.name}** (\`${resumableRun.id}\`), which ` +
            'keeps the model bindings it started with — the bindings you supplied now ' +
            `(${suppliedModelBindingNames.join(', ')}) were not applied. To run fresh with them ` +
            `instead, abandon that run first (\`/workflow abandon ${resumableRun.id}\`) and re-invoke.`
        );
      }
      // The wrap owns the capture until `executeWorkflow`'s rename succeeds; the
      // executor adopts for us there (see #2690). Until then a rename failure leaves
      // the staged directory un-adopted so the wrap reclaims it on the way out.
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
          preparedSource,
          parseWarnings: options?.parseWarnings,
          baseBranch: codebaseBaseBranch,
          resolveChildIsolation,
          capturedSourceOwner: owner,
          ...prepared,
        }
      );
    } else {
      // Hydration found nothing worth resuming, so this is the ONE continuation path
      // that creates a fresh run row — which means a contract violation deferred at the
      // gate is live again and must be surfaced before any AI cost.
      if (deferredInputError) {
        await platform.sendMessage(conversationId, deferredInputError.message);
        return;
      }
      // This branch IS a fresh run, even though the outer block entered via the resume
      // menu (#2686). Capture the source here so the run freezes the bytes it actually
      // executes against; without this it would inherit the prior run's frozen graph
      // and let the executor fall back to live command/script lookup, which is exactly
      // the mixed-vintage shape #2660 exists to remove.
      const captured = await captureFreshSource(owner, runCwd, workflow, conversationId, platform);
      if (!captured) return; // capture failed, message already sent
      workflow = captured.workflow;
      await platform.sendMessage(
        conversationId,
        `⚠️ Prior run for **${workflow.name}** had no completed nodes; starting fresh in the same worktree.`
      );
      // The wrap owns the capture until `executeWorkflow`'s rename succeeds; the
      // executor adopts for us there (see #2690). `captured.preparedSource` proves
      // the helper has already run `owner.hold`, which is the only thing the wrap
      // needs to know to reclaim if the rename fails.
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
          preparedSource: captured.preparedSource,
          parseWarnings: options?.parseWarnings,
          baseBranch: codebaseBaseBranch,
          resolveChildIsolation,
          capturedSourceOwner: owner,
          // This branch creates a FRESH run row (the prior run had nothing to resume),
          // so the supplied inputs still need stamping.
          inputs: resolvedInputs,
          ...(options?.modelOverrides
            ? {
                modelOverrideLayer: {
                  kind: 'raw' as const,
                  overrides: options.modelOverrides,
                },
              }
            : {}),
          ...(options?.runConfig ? { runConfig: options.runConfig } : {}),
        }
      );
    }
  } else if (platform.getPlatformType() === 'web' && !workflow.interactive) {
    // Background dispatch: web-only, non-interactive workflows with no resumable run.
    // This is the console's default path, so it is exactly where a console-supplied
    // input map must not be dropped.
    //
    // `dispatchBackgroundWorkflow` refuses a composed approval gate a background run
    // cannot present (#1764); turn that into a message rather than an unhandled throw.
    try {
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
          parseWarnings: options?.parseWarnings,
          inputs: resolvedInputs,
          modelOverrides: options?.modelOverrides,
          runConfig: options?.runConfig,
          adoptRunId: options?.adoptRunId,
          supersedesRunId: options?.supersedesRunId,
          adoptionLane,
        },
        workflow
      );
    } catch (err) {
      if (err instanceof ComposedApprovalGateError) {
        getLog().info(
          { workflowName: workflow.name, conversationId, gate: err.gate },
          'workflow.composed_gate_undriveable'
        );
        await platform.sendMessage(conversationId, err.message);
        return;
      }
      throw err;
    }
  } else {
    // Fresh foreground execution: web interactive workflows + all chat platforms.
    // Reaching this branch means `resumableRun?.working_path` is falsy, which implies
    // `willContinueExistingRun` was false and step 2 above ran. `freshCaptured` is
    // invariantly defined here — the capture-flow helper ran before this branch.
    if (!freshCaptured) {
      // Should never trigger; the reasoning above is the invariant. If it does, the
      // dispatch returned a `preparedSource: undefined` to the executor and we are
      // about to fall into the executor's `source_unprepared_live` branch — the
      // mixed-vintage shape #2660 exists to remove — so refuse loudly rather than
      // ship that regression silently.
      throw new Error(
        'orchestrator invariant violated: fresh-foreground dispatch reached without a captured source'
      );
    }
    // The wrap owns the capture until `executeWorkflow`'s rename succeeds; the
    // executor adopts for us there (see #2690). `freshCaptured` proves the prior
    // `captureFreshSource` call already ran `owner.hold`.
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
        preparedSource: freshCaptured.preparedSource,
        parseWarnings: options?.parseWarnings,
        baseBranch: codebaseBaseBranch,
        resolveChildIsolation,
        capturedSourceOwner: owner,
        inputs: resolvedInputs,
        ...(options?.adoptRunId
          ? { adoptedFromRunId: options.adoptRunId, continuationMode: 'adopt' as const }
          : options?.supersedesRunId
            ? {
                adoptedFromRunId: options.supersedesRunId,
                continuationMode: 'supersede' as const,
              }
            : {}),
        ...(options?.modelOverrides
          ? {
              modelOverrideLayer: { kind: 'raw' as const, overrides: options.modelOverrides },
            }
          : {}),
        ...(options?.runConfig ? { runConfig: options.runConfig } : {}),
      }
    );
  }
}

/**
 * Freeze the workflow source and re-resolve the workflow FROM the freeze.
 *
 * A fresh run row is created from the captured bytes — commands and scripts beside
 * the DAG come from the same moment as the DAG itself. Without this, an edited
 * workflow would silently run its new graph against pre-edit command bytes; this is
 * the exact shape #2660 exists to remove, and the exact shape that must be avoided in
 * the fresh-run-in-same-worktree fallback (#2686).
 *
 * On success: hands the staged capture to the owner (`hold`), records the selected
 * workflow name, and returns both the prepared source and the freshly resolved graph.
 * The caller adopts when a run takes over.
 *
 * On failure: sends the user-facing message and returns `undefined`. The caller MUST
 * `return` immediately — the owner reclaims any unadopted capture on the way out, so
 * no manual cleanup is needed.
 */
async function captureFreshSource(
  owner: CapturedSourceOwner,
  runCwd: string,
  workflow: ResolvedWorkflow,
  conversationId: string,
  platform: IPlatformAdapter,
  explicitSourceRoot?: string
): Promise<{ preparedSource: PreparedWorkflowSource; workflow: ResolvedWorkflow } | undefined> {
  try {
    const workflowSourceRoot = explicitSourceRoot ?? (await resolveWorkflowSourceRoot(runCwd));
    const preparedSource = await prepareWorkflowSource(createWorkflowDeps(), {
      sourceRoot: workflowSourceRoot ?? runCwd,
    });
    // From here the owner reclaims it unless a run adopts it, whichever way we leave.
    owner.hold(preparedSource);
    // Re-resolve only when files were actually frozen. An empty capture means the
    // definition came from the bundled set a binary embeds as constants — immutable for
    // that binary, with nothing on disk to re-read.
    let resolvedWorkflow = workflow;
    if (preparedSource.manifest.scopes.length > 0) {
      const { workflows: capturedWorkflows } = await discoverWorkflowsWithConfig(
        runCwd,
        loadConfig,
        preparedSource.roots
      );
      const reResolved = resolveWorkflowName(
        workflow.name,
        capturedWorkflows.map(w => w.workflow)
      );
      if (!reResolved) {
        // No manual cleanup: the owner reclaims anything unadopted on the way out.
        await platform.sendMessage(
          conversationId,
          `Could not read workflow **${workflow.name}** from this run's captured source. ` +
            'Nothing has been started.'
        );
        return undefined;
      }
      resolvedWorkflow = reResolved;
    }
    await recordSelectedWorkflow(preparedSource.captureRoot, resolvedWorkflow.name);
    return { preparedSource, workflow: resolvedWorkflow };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName: workflow.name }, 'workflow.source_capture_failed');
    await platform.sendMessage(
      conversationId,
      `Could not capture the workflow source for **${workflow.name}**: ${err.message}. ` +
        'Nothing has been started.'
    );
    return undefined;
  }
}

/**
 * Dispatch a workflow, owning any capture it takes.
 *
 * A thin owner around the implementation, matching the CLI's shape. The implementation has
 * five ordinary early returns after a capture is allocated — the inputs gate, the GitHub
 * requirement gate, an isolation error, a resume with no working path, and the routine
 * "resume or force?" menu — and every one of them used to abandon a complete frozen tree.
 */
async function dispatchOrchestratorWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  workflow: ResolvedWorkflow,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints'],
  userId?: string,
  source?: WorkflowSource,
  options?: WorkflowDispatchOptions
): Promise<void> {
  await withCapturedSource(owner =>
    dispatchOrchestratorWorkflowOwned(
      owner,
      platform,
      conversationId,
      conversation,
      codebase,
      workflow,
      userMessage,
      isolationHints,
      userId,
      source,
      options
    )
  );
}

/** A human gate the chat agent resolved during a turn, awaiting continuation. */
interface ResolvedGate {
  run: WorkflowRun;
  action: 'approve' | 'reject' | 'respond';
}

/**
 * Continue a run whose human gate the chat agent just resolved (#2565).
 *
 * A resolution leaves the run `paused` on purpose — `approveWorkflow` and
 * `rejectWorkflow` record the decision and let the caller decide when to move
 * (`workflow-operations.ts`). This is chat's "when": the same resume dispatch the
 * removed natural-language branch performed, now triggered by the agent's
 * explicit approve/reject verb instead of by "the message did not start with /".
 * Resolution without continuation would strand the run on every chat surface.
 *
 * Never throws — the gate decision is already committed, so a failure here costs
 * the user a manual `/workflow resume`, not the decision. The whole body is
 * guarded so that guarantee holds for the `finally` this runs from, where a
 * throw would replace the error the user actually needs to see.
 *
 * Exported so its continuation behavior can be tested without staging a whole agent turn
 * with a gate-resolving tool call.
 */
export async function continueResolvedGateRun(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase | null,
  workflowsWithSource: readonly WorkflowWithSource[],
  run: WorkflowRun,
  action: 'approve' | 'reject' | 'respond',
  isolationHints?: HandleMessageContext['isolationHints'],
  userId?: string
): Promise<void> {
  const decision =
    action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Responded';
  const notify = async (text: string): Promise<void> => {
    await platform.sendMessage(conversationId, text).catch((sendErr: unknown) => {
      getLog().warn(
        { err: toError(sendErr), conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_notice_failed'
      );
    });
  };

  try {
    if (!codebase) {
      getLog().warn(
        { conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_no_codebase'
      );
      await notify(
        `${decision}, but no project is attached to this conversation, so the run could not ` +
          `continue. The decision is recorded — use \`/workflow resume ${run.id}\` from the project.`
      );
      return;
    }

    // The graph this run FROZE. The chat turn's discovery list describes the checkout as
    // it is NOW, which is the wrong question twice over: a workflow deleted or renamed
    // since the run started is missing from it, and this path would then refuse a run
    // whose own captured source still holds it. `/workflow resume` resolves it this way
    // too — the two gate surfaces must not disagree about what a run is.
    let resolvedContinuation: ResolvedWorkflow | undefined;
    try {
      resolvedContinuation = (
        await resolveContinuationWorkflow(
          createWorkflowDeps(),
          run,
          conversation.cwd ?? codebase.default_cwd
        )
      )?.workflow;
    } catch (error) {
      const err = toError(error);
      getLog().error(
        { err, conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_source_failed'
      );
      await notify(
        `${decision}, but run \`${run.id}\` could not continue: ${err.message} ` +
          'The decision is recorded — start a fresh run to execute the current workflow.'
      );
      return;
    }

    // Undefined only for a run predating captures: fall back to the live list, exactly
    // as that run's executor does.
    const workflow =
      resolvedContinuation ??
      findWorkflow(
        run.workflow_name,
        workflowsWithSource.map(w => w.workflow)
      );
    if (!workflow) {
      getLog().warn(
        { conversationId, workflowRunId: run.id, workflowName: run.workflow_name },
        'orchestrator.gate_continuation_workflow_not_found'
      );
      await notify(
        `${decision}, but workflow \`${run.workflow_name}\` was not found, so the run could not ` +
          'continue. The decision is recorded — use `/workflow list` to check available workflows.'
      );
      return;
    }

    const source = workflowsWithSource.find(w => w.workflow === workflow)?.source;
    getLog().info(
      { conversationId, workflowRunId: run.id, workflowName: workflow.name, action },
      'orchestrator.gate_continuation_started'
    );
    try {
      await notify(`▶️ Resuming **${workflow.name}**...`);
      await dispatchOrchestratorWorkflow(
        platform,
        conversationId,
        conversation,
        codebase,
        workflow,
        run.user_message,
        isolationHints,
        userId,
        source,
        // Already verified and discovered above; dispatch reuses it rather than
        // resolving the same capture a second time.
        { resumeRunId: run.id, resumeRun: run, resolvedContinuation }
      );
      getLog().info(
        { conversationId, workflowRunId: run.id, workflowName: workflow.name, action },
        'orchestrator.gate_continuation_completed'
      );
    } catch (error) {
      const err = toError(error);
      // The run's terminal status could not be written, so its row still says `running`
      // and its true outcome is unknown. `/workflow resume` is the wrong advice — it
      // refuses a non-terminal row, and the run may well have finished its work.
      if (error instanceof TerminalStatusWriteError) {
        getLog().error(
          { err, conversationId, workflowRunId: run.id, action },
          'orchestrator.gate_continuation_terminal_write_failed'
        );
        await notify(
          `${decision}, and **${workflow.name}** ran, but its final status could not be saved ` +
            `(${err.message}). The decision is recorded — check \`/workflow status ${run.id}\` ` +
            'before starting another run on this project.'
        );
        return;
      }
      getLog().error(
        { err, errorType: err.constructor.name, conversationId, workflowRunId: run.id, action },
        'orchestrator.gate_continuation_failed'
      );
      await notify(
        `${decision}, but resuming **${workflow.name}** failed: ${err.message}. ` +
          `The decision is recorded — retry with \`/workflow resume ${run.id}\`.`
      );
    }
  } catch (error) {
    // Belt and braces for the "never throws" contract the finally relies on.
    getLog().error(
      { err: toError(error), conversationId, workflowRunId: run.id, action },
      'orchestrator.gate_continuation_failed'
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
  codebase?: Codebase | null;
  /** Remote name used for the workspace sync (undefined when no sync ran). */
  remote?: string;
}

/** Discover global + repo-specific workflows, merge by name (repo overrides global) */
async function discoverAllWorkflows(conversation: Conversation): Promise<DiscoverResult> {
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
    const result = await discoverWorkflowsWithConfig(getArchonWorkspacesPath(), loadConfig);
    workflows = [...result.workflows];
    allErrors.push(...result.errors);
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, errorType: err.constructor.name }, 'global_workflow_discovery_failed');
  }

  if (conversation.codebase_id) {
    try {
      codebase = await codebaseDb.getCodebase(conversation.codebase_id);
      if (codebase) {
        // Sync canonical source with remote before the AI reads codebase state.
        // This path must remain non-destructive: users and agents can write to source/.
        // Non-fatal: if fetch fails (network, no remote), proceed with local state.
        // Folder projects have no git repo to sync — skip entirely.
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
        // Read workflows from the authoring repo rather than copying its `.archon` into
        // this worktree first. Config still comes from `workflowCwd` — settings belong to
        // the workspace being acted on.
        const workflowSourceRoot = await resolveWorkflowSourceRoot(workflowCwd);
        // Load config once for this codebase path; reuse below to avoid a second disk read
        const loadedConfig = await loadConfig(workflowCwd);
        config = loadedConfig;
        const repoResult = await discoverWorkflowsWithConfig(
          workflowCwd,
          () => Promise.resolve(loadedConfig),
          workflowSourceRoot === undefined ? undefined : liveSourceRoots(workflowSourceRoot)
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

  return { workflows, errors: allErrors, syncResult, syncError, config, codebase, remote };
}

/** Build the user-facing prompt with message and optional contexts */
function buildFullPrompt(
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
  // Anchor "is this a slash command" at the true start of the message —
  // leading whitespace (e.g. from a platform that doesn't pre-trim after
  // stripping a bot mention) must not let a command masquerade as a plain
  // AI turn. Mirrors the trim already done inside commandHandler.parseCommand.
  const trimmedMessage = message.trim();
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

    // 2. Check for deterministic commands
    if (trimmedMessage.startsWith('/')) {
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
          // Pass the full Conversation — handleSetProject updates by the DB
          // primary key (conversation.id, not the platform conversation id)
          // and needs the prior cwd/isolation state for the detach note.
          const result = await handleSetProject(message, conversation);
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
            userId,
            {
              force: result.workflow.force,
              resumeRunId: result.workflow.resumeRunId,
              resumeRun: result.workflow.resumeRun,
              resolvedContinuation: result.workflow.resolvedContinuation,
              parseWarnings: result.workflow.parseWarnings,
              // Declared inputs (#2554) arrive on the request context, not in the
              // command text — the run route is the only caller that sets them.
              inputs: context?.workflowInputs,
              modelOverrides: context?.workflowModelOverrides,
              runConfig: context?.workflowRunConfig,
              // Between-run continuation (#2747), same channel.
              adoptRunId: context?.workflowAdoptRunId,
              supersedesRunId: context?.workflowSupersedesRunId,
            }
          );
        }
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
            // The name is quoted, and `"`/`\` inside it escaped, so the suggestion
            // round-trips back through parseCommand as the same string. Without the
            // quotes, handleUpdateProject takes only the first token as the name
            // (`const [projectName, ...pathParts] = args`), so `Client Ops` parses
            // as `Client` and hands the user a second, wronger error; without the
            // escaping, a name containing a quote terminates the quoted token early
            // and does the same thing. parseCommand honours backslash escapes inside
            // quotes (command-handler.ts:206-212), and both are no-ops for a plain
            // name.
            `- \`/update-project "${scoped.name.replace(/[\\"]/g, c => `\\${c}`)}" <new-path>\` ` +
            'to point it at the new location\n' +
            '- `/setproject <name>` to switch this conversation to a different project'
        );
        return;
      }
    }

    // Persist the inbound user message for non-web platforms (Slack/Telegram/
    // GitHub/Discord/CLI) — the web adapter's route persists web turns itself.
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
    if (!isWebAdapter(platform)) {
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
        type: 'system',
        content: 'Sync failed \u2014 using local state',
      });
    } else if (syncResult?.state === 'diverged' && platform.sendStructuredEvent) {
      await platform.sendStructuredEvent(conversationId, {
        type: 'system',
        content: `Local source/ has diverged from ${syncRemote ?? 'origin'}/${syncResult.branch} \u2014 manual merge or rebase needed`,
      });
    } else if (
      syncResult?.state === 'in_sync' &&
      syncResult.updated &&
      platform.sendStructuredEvent
    ) {
      await platform.sendStructuredEvent(conversationId, {
        type: 'system',
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
    const protectedEnvKeys = Object.keys(userProviderEnv);
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
      protectedEnvKeys: protectedEnvKeys.length > 0 ? protectedEnvKeys : undefined,
      model: chatRequest.model,
      systemPrompt,
    };
    if (chatRequest.preset) {
      applyPresetToRequestOptions(providerKey, chatRequest.preset, requestOptions);
    }

    if (!conversation.title && !trimmedMessage.startsWith('/')) {
      const titleRequest = resolveModelRequest(aiProfile, 'small', configuredProviderKey);
      const titleOptions: SendQueryOptions = {
        model: titleRequest.model,
        assistantConfig: { ...(config.assistants[titleRequest.provider] ?? {}) },
        // Thread the per-user credential bag so title generation authenticates as
        // the sender too. Without this, title-gen runs with no per-user
        // subscription/key and fails on per-user-only installs (#1984; same family
        // as #1794/#1855). Same env-only bag as the main chat request above.
        env: Object.keys(effectiveEnv).length > 0 ? effectiveEnv : undefined,
        protectedEnvKeys: protectedEnvKeys.length > 0 ? protectedEnvKeys : undefined,
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

    // Written by the `manage_run` tool when the agent resolves a human gate
    // during this turn, and acted on once the turn ends (#2565). Resolving a
    // gate and continuing the run are two halves of one action — the tool
    // records the intent so its call returns immediately, and the resume runs
    // here rather than blocking the agent loop on a whole workflow. Held in an
    // object because a `let` assigned only from a callback narrows to `null`.
    const gateResolution: { resolved: ResolvedGate | null } = { resolved: null };

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
          // One continuation per turn: the resume runs in this conversation and
          // to completion, so a second gate resolved in the same turn is
          // declined rather than silently dropped (the tool tells the agent).
          onGateResolved: (run, action) => {
            if (gateResolution.resolved !== null) return false;
            gateResolution.resolved = { run, action };
            return true;
          },
          startWorkflow: async (workflowName, msg): Promise<string> => {
            let wf: ResolvedWorkflow | undefined;
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
    // `finally`, not straight-line code: the gate resolution is committed to the
    // DB the moment the tool call returns, so once the agent has resolved a gate
    // the continuation must run even if the rest of the turn throws — a provider
    // subprocess crash after a successful tool call would otherwise leave the run
    // resolved and parked with only a generic error to show for it. The outer
    // catch cannot cover this: it does not know about the resolution.
    // continueResolvedGateRun never throws, so this cannot mask the real error.
    try {
      if (mode === 'stream') {
        await handleStreamMode(
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
          workflowsWithSource,
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
    } finally {
      if (gateResolution.resolved !== null) {
        await continueResolvedGateRun(
          platform,
          conversationId,
          conversation,
          discoveredCodebase ?? null,
          workflowsWithSource,
          gateResolution.resolved.run,
          gateResolution.resolved.action,
          isolationHints,
          userId
        );
      }
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
  workflows: readonly WorkflowWithSource[],
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
        // Carry the SDK error detail (not just the subtype code) into the
        // formatter so it can classify actionable cases like "Not logged in"
        // rather than emitting a generic message (#1983).
        const errorDetail = [msg.errorSubtype, ...(msg.errors ?? [])].filter(Boolean).join(': ');
        const syntheticError = new Error(errorDetail || 'AI result error');
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
  const commands = parseOrchestratorCommands(
    fullResponse,
    codebases,
    workflows.map(ws => ws.workflow)
  );

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

  // Text was already streamed — nothing more to send.
  // Persist the assistant reply for non-web platforms so it appears in the
  // Web UI conversation history. The web adapter persists through its
  // MessagePersistence buffer; skip it here to avoid double-write (#1182).
  if (!isWebAdapter(platform) && fullResponse) {
    messageDb.addMessage(conversation.id, 'assistant', fullResponse).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().warn(
        { err, errorType: err.constructor.name, conversationId },
        'orchestrator.assistant_message_persist_failed'
      );
    });
  }
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
  workflows: readonly WorkflowWithSource[],
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
        // Carry the SDK error detail (not just the subtype code) into the
        // formatter so it can classify actionable cases like "Not logged in"
        // rather than emitting a generic message (#1983).
        const errorDetail = [msg.errorSubtype, ...(msg.errors ?? [])].filter(Boolean).join(': ');
        const syntheticError = new Error(errorDetail || 'AI result error');
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
  const commands = parseOrchestratorCommands(
    assistantMessages.join(''),
    codebases,
    workflows.map(ws => ws.workflow)
  );

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
  // Persist the assistant reply for non-web platforms so it appears in the
  // Web UI conversation history. The web adapter persists through its
  // MessagePersistence buffer; skip it here to avoid double-write (#1182).
  if (!isWebAdapter(platform) && finalMessage) {
    messageDb.addMessage(conversation.id, 'assistant', finalMessage).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().warn(
        { err, errorType: err.constructor.name, conversationId },
        'orchestrator.assistant_message_persist_failed'
      );
    });
  }
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
  workflows: readonly WorkflowWithSource[],
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
      workflow,
      workflowPrompt,
      isolationHints,
      userId,
      workflowEntry?.source,
      { parseWarnings: workflowEntry?.parseWarnings }
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

  // Canonicalize through the one shared `default_cwd` canonicalizer, the same
  // one `registerFolder`, the CLI gate and `archon doctor` use. Calling a
  // different realpath variant here is what made a chat-registered project and a
  // CLI-registered project disagree on Windows and register two rows (#2927).
  // It runs BEFORE the existence check so the path being validated is the path
  // being stored — and because chat input gets no shell expansion, so `~/work`
  // arrives literally and only this call can resolve it.
  const canonicalPath = await canonicalizeProjectPath(projectPath);

  if (!existsSync(canonicalPath)) {
    return `Path does not exist: ${canonicalPath}`;
  }

  // Check if codebase already exists with this name
  const existing = await codebaseDb.listCodebases();
  const alreadyExists = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (alreadyExists) {
    return `Project "${projectName}" is already registered (path: ${alreadyExists.default_cwd}).`;
  }

  // Use config default provider instead of hardcoding 'claude'
  const config = await loadConfig();

  // Detect whether the path is a git repository. Non-git paths (multi-repo roots
  // or plain ops folders) register as folder projects — run-in-place, no branch.
  // findRepoRoot returns null ONLY for a definitive "not a git repository"; it
  // throws for genuine failures (git missing, timeout, permission). Since `kind`
  // is persisted and mis-setting it to 'folder' permanently strips a real repo's
  // worktree/branch capability, we do NOT silently treat a throw as folder: log
  // loudly and tell the user so they can re-register after resolving the error.
  let repoRoot: string | null = null;
  let repoDetectFailed = false;
  try {
    repoRoot = await findRepoRoot(canonicalPath);
  } catch (err) {
    repoDetectFailed = true;
    getLog().warn(
      { err: err as Error, projectPath: canonicalPath },
      'project.register_repo_detect_failed'
    );
  }
  const kind: 'repo' | 'folder' = repoRoot ? 'repo' : 'folder';
  const detectedBranch = kind === 'repo' ? await detectCurrentGitBranch(canonicalPath) : null;
  const codebase = await codebaseDb.createCodebase({
    name: projectName,
    default_cwd: canonicalPath,
    default_branch: detectedBranch,
    ai_assistant_type: config.assistant,
    kind,
  });

  getLog().info(
    { name: projectName, path: canonicalPath, id: codebase.id, kind },
    'project.register_completed'
  );
  let kindNote = kind === 'folder' ? '\nKind: folder project (no git — runs in place)' : '';
  if (repoDetectFailed) {
    kindNote +=
      '\n⚠️ Could not determine git status (git error) — registered as a folder project. ' +
      'If this should be a git repo, resolve the error and re-register.';
  }
  return `Project "${projectName}" registered successfully!\nPath: ${canonicalPath}\nID: ${codebase.id}${kindNote}`;
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
  const suppliedPath = pathParts.join(' ');

  // A repointed project has to land on the same canonical form the lookups ask
  // for, exactly like a freshly registered one — storing the raw argument here
  // wrote a `default_cwd` no reader could match (#2927). Canonicalize before
  // validating, so the path checked is the path stored and a chat-supplied
  // `~/work` resolves (chat input gets no shell expansion).
  const newPath = await canonicalizeProjectPath(suppliedPath);

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
    // Row gone (deleted between the fetch above and the UPDATE) is the only
    // case where "removed" is the honest answer; anything else is an
    // operational DB failure and should say so instead of blaming data state.
    if (err instanceof codebaseDb.CodebaseNotFoundError) {
      return `Project "${projectName}" could not be updated — it appears to have been removed. Use /register-project to re-create it.`;
    }
    return `Project "${projectName}" could not be updated — database error. Please try again.`;
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
 * Handle /setproject command. Four effects:
 * 1. Binds the conversation to the resolved codebase (writes `codebase_id`).
 * 2. Clears `cwd` — the project root remains codebase.default_cwd;
 *    conversation.cwd is only an explicit runtime override.
 * 3. Clears `isolation_env_id` — the old project's worktree no longer applies.
 * 4. Deactivates the active AI session ('project-changed'), so the next
 *    message starts fresh in the new project's context.
 * Uses 4-tier fuzzy name resolution (exact → case-insensitive → prefix →
 * substring) via resolveCodebaseName. Updates by the DB primary key
 * (conversation.id), never the platform conversation id.
 */
async function handleSetProject(message: string, conversation: Conversation): Promise<string> {
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

  // Deactivate the old session BEFORE rebinding the conversation: if either
  // session step throws, the switch aborts with the conversation untouched
  // (next message just starts a fresh session in the OLD project). The reverse
  // order would leave a rebound conversation with the old project's session
  // still active — resuming old-project context under the new project's cwd.
  const session = await sessionDb.getActiveSession(conversation.id);
  if (session) {
    await safeDeactivateSession(session.id, 'setproject');
  }

  // Intentionally non-destructive: clearing isolation_env_id detaches the
  // conversation from its worktree WITHOUT destroying it — the worktree may
  // hold uncommitted work and the user may switch back (project-switch is not
  // terminal, unlike conversation-closed). The env row stays active until
  // /worktree remove or the periodic isolation cleanup reaps it; we surface
  // that to the user below instead of tearing it down.
  const detachedWorktree = conversation.isolation_env_id !== null;
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
    cwd: null,
    isolation_env_id: null,
  });
  if (detachedWorktree) {
    getLog().info(
      { conversationId: conversation.id, isolationEnvId: conversation.isolation_env_id },
      'project.set_worktree_detached'
    );
  }

  getLog().info(
    { conversationId: conversation.id, projectName: codebase.name, codebaseId: codebase.id },
    'project.set_completed'
  );
  let reply = `Project set to **${codebase.name}**\nWorking directory: ${codebase.default_cwd}`;
  if (detachedWorktree) {
    // Don't suggest `/worktree remove` here: it reads isolation_env_id from
    // THIS conversation, which we just cleared — it would short-circuit with
    // "not using a worktree". Cleanup tools that operate on the environments
    // table directly are the working remedies.
    reply +=
      '\n\nNote: the previous worktree was detached but left in place — clean it up with `archon isolation cleanup` or from the project’s Environments list in the web UI.';
  }
  return reply;
}

/**
 * Handle /workflow run command when project context may be missing.
 * Implements Edge Case E2 from the plan.
 */
async function handleWorkflowRunCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  workflow: ResolvedWorkflow,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints'],
  userId?: string,
  options?: WorkflowDispatchOptions
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
      userId,
      undefined,
      options
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
    // Authoring root for discovery (the canonical repo when `workflowCwd` is a worktree).
    // This THROWS when git cannot answer — the docblock that once said otherwise was
    // corrected, and this caller had copied the old claim. Guarded rather than propagated
    // because this branch only LISTS workflows to validate a name: degrading to the cwd
    // shows a slightly narrower list, while failing would refuse the command outright.
    let workflowSourceRoot: string | undefined;
    try {
      workflowSourceRoot = await resolveWorkflowSourceRoot(workflowCwd);
    } catch (error) {
      getLog().warn(
        { err: error as Error, workflowCwd },
        'workflow.source_root_unresolved_listing'
      );
    }

    let discovery;
    try {
      discovery = await discoverWorkflowsWithConfig(
        workflowCwd,
        loadConfig,
        workflowSourceRoot === undefined ? undefined : liveSourceRoots(workflowSourceRoot)
      );
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
      resolvedEntry?.source,
      // Warnings must describe the workflow that will EXECUTE. This branch
      // RE-RESOLVES the workflow against the single project's discovery, which
      // can land on a different file than the caller resolved (a project
      // workflow shadowing a same-named global one). Inheriting the caller's
      // warnings would then describe a workflow that is not running.
      { ...options, parseWarnings: resolvedEntry?.parseWarnings }
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
