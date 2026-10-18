/**
 * One direct-chat turn: send the prompt to the provider, stream or batch its reply, and
 * route a command the reply carries. The turn's telemetry goes through `reportChatTurn`.
 */
import type { RunActor } from '../operations/run-authorization';
import { captureChatTurn } from '@archon/paths';
import type { IPlatformAdapter, HandleMessageContext, Conversation, Codebase } from '../types';
import type { ResultChunk, SendQueryOptions, TokenUsage } from '@archon/providers/types';
import {
  addResultUsage,
  sessionPreview,
  toolCallDisplayName,
  type ResultUsageTotal,
} from '@archon/provider-contract';
import * as sessionDb from '../db/sessions';
import { formatToolCall } from '@archon/workflows/utils/tool-formatter';
import { classifyAndFormatError, formatProviderFailure } from '../utils/error-formatter';
import { toError } from '../utils/error';
import type { getAgentProvider } from '../services/provider-admission';
import { findCodebaseByName, type ProjectRegistration } from './chat-tools';
import { findWorkflow } from '@archon/workflows/router';
import type { WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import { getLog } from './agent-log';
import {
  NO_COMMANDS,
  hasCommandPrefix,
  isCommandFullyParsed,
  normalizeCommandText,
  parseOrchestratorCommands,
  type OrchestratorCommands,
  type WorkflowInvocation,
} from './command-scan';
import { registerProject } from './project-commands';
import * as messageDb from '../db/messages';
import { dispatchOrchestratorWorkflow } from './workflow-dispatch';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max assistant text chunks to keep in batch mode (oldest are dropped) */
const MAX_BATCH_ASSISTANT_CHUNKS = 20;
/** Max total chunks (assistant + tool) to keep in batch mode */
const MAX_BATCH_TOTAL_CHUNKS = 200;

// ─── Batch Mode Helpers ─────────────────────────────────────────────────────

/**
 * Filter emoji tool indicators from Claude Code SDK responses.
 * These prefixed sections (🔧, 💭, 📝, etc.) are useful for streaming UIs
 * but garble batch-mode text output on platforms like Slack/GitHub/CLI.
 */
export function filterToolIndicators(assistantMessages: string[]): string {
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

/**
 * One direct-chat turn's telemetry state. Every `chat_turn_handled` for the turn goes
 * through {@link reportChatTurn}, so the dispatcher's failure report can tell whether a
 * mode handler already reported and never counts one turn twice.
 */
export interface ChatTurn {
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

export function reportChatTurn(turn: ChatTurn, props: Parameters<typeof captureChatTurn>[0]): void {
  turn.reported = true;
  turn.failed = props.outcome === 'failed';
  captureChatTurn(props);
}

/** Everything one chat turn's mode handler reads, built once by `handleMessage`. */
export interface ChatTurnInput {
  readonly turn: ChatTurn;
  /** Providers without in-process tools write command lines that the scan reads from the reply. */
  readonly commandScan: boolean;
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly originalMessage: string;
  readonly codebases: readonly Codebase[];
  readonly workflows: readonly WorkflowWithSource[];
  readonly aiClient: ReturnType<typeof getAgentProvider>;
  readonly fullPrompt: string;
  readonly cwd: string;
  readonly session: { id: string; assistant_session_id: string | null };
  readonly isolationHints: HandleMessageContext['isolationHints'];
  readonly conversation: Conversation;
  readonly actor: RunActor;
  readonly issueContext?: string;
  readonly requestOptions: SendQueryOptions;
}

/** Usage summed over every `result` chunk of the turn, as the workflow engine sums a node. */
type TurnResult = ResultUsageTotal & { stopReason?: string };

/**
 * The provider session id to persist after a `result` chunk. An `error_during_execution`
 * result clears the stored id, which the provider can no longer resume.
 */
async function sessionIdAfterResult(
  input: ChatTurnInput,
  msg: ResultChunk,
  current: string | undefined
): Promise<string | undefined> {
  if (msg.isError && msg.errorSubtype === 'error_during_execution') {
    getLog().warn(
      {
        conversationId: input.conversationId,
        errorSubtype: msg.errorSubtype,
        ...(msg.sessionId ? { staleSessionIdPreview: sessionPreview(msg.sessionId) } : {}),
        errors: msg.errors,
        stopReason: msg.stopReason,
      },
      'clearing_stale_session_id'
    );
    await tryPersistSessionId(input.session.id, null);
    return undefined;
  }
  if (msg.sessionId) return msg.sessionId;
  return current;
}

/**
 * When the `result` chunk is a failure, tell the user, persist the session and report the
 * failed turn. Returns whether it was one; the turn then ends.
 */
async function reportFailedResult(
  input: ChatTurnInput,
  msg: ResultChunk,
  newSessionId: string | undefined
): Promise<boolean> {
  // Defense-in-depth: errorSubtype === 'success' is the Claude SDK's marker
  // for a clean stop_sequence termination (the SDK sets is_error: true
  // alongside subtype: 'success' to encode "non-default termination, not a
  // failure"). The Claude provider already filters this; the guard here
  // defends against a third-party IAgentProvider that forwards the SDK
  // pair raw — without it, direct chat would surface a spurious error to
  // the user and drop the actual conversation output.
  const failed = msg.failure !== undefined || (msg.isError && msg.errorSubtype !== 'success');
  if (!failed) return false;
  const { turn, platform, conversationId, aiClient, session, requestOptions } = input;
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
    model: requestOptions.model,
    durationMs: Date.now() - turn.startedAt,
    outcome: 'failed',
  });
  return true;
}

/**
 * Route a command the scan found in the reply: retract the reply and dispatch the workflow
 * or register the project. Returns whether it routed. `registrationText` is the reply the
 * registration preamble is extracted from.
 */
async function routeScannedCommand(
  input: ChatTurnInput,
  commands: OrchestratorCommands,
  registrationText: string
): Promise<boolean> {
  const { turn, platform, conversationId } = input;
  if (commands.workflowInvocation) {
    turn.routed = true;
    // Retract the reply text — workflow dispatch replaces it
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleWorkflowInvocationResult(
      platform,
      conversationId,
      input.conversation,
      input.codebases,
      input.workflows,
      commands.workflowInvocation,
      input.originalMessage,
      input.isolationHints,
      input.actor,
      input.issueContext
    );
    return true;
  }

  if (commands.projectRegistration) {
    turn.routed = true;
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleProjectRegistrationResult(
      platform,
      conversationId,
      registrationText,
      commands.projectRegistration
    );
    return true;
  }
  return false;
}

/** Persist the reply, send the result footer and report the completed turn. */
async function completeChatTurn(
  input: ChatTurnInput,
  text: string,
  turnResult: TurnResult | undefined
): Promise<void> {
  const { turn, platform, conversationId, conversation, aiClient, requestOptions } = input;
  // Adapter-owned storage must not get a second copy of the assistant reply (#1182).
  if (platform.capabilities.messagePersistence === 'core' && text) {
    messageDb.addMessage(conversation.id, 'assistant', text).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().warn(
        { err, errorType: err.constructor.name, conversationId },
        'orchestrator.assistant_message_persist_failed'
      );
    });
  }
  await maybeSendResultFooter(platform, conversationId, turnResult);
  // Anonymous telemetry: one completed direct-chat turn. A turn the command scan routed
  // returns before this — those are covered by workflow_invoked / codebase_registered
  // instead. Platform + provider only, never message content.
  reportChatTurn(turn, {
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions.model,
    // durationMs deliberately measures from mode-handler entry — it includes
    // pre-AI setup, i.e. "time the user waited", not pure model latency.
    durationMs: Date.now() - turn.startedAt,
    costUsd: turnResult?.cost,
    tokensIn: turnResult?.tokens?.input,
    tokensOut: turnResult?.tokens?.output,
    outcome: 'completed',
  });
}

// ─── Streaming Mode ─────────────────────────────────────────────────────────

/**
 * Stream mode: send text chunks immediately for real-time UX (web, Telegram stream).
 * With `commandScan` on (providers without in-process tools), a detected orchestrator
 * command retracts the streamed text and dispatches.
 */
export async function handleStreamMode(input: ChatTurnInput): Promise<void> {
  const { commandScan, platform, conversationId, aiClient, fullPrompt, cwd, session } = input;
  const allMessages: string[] = [];
  let newSessionId: string | undefined;
  let commandDetected = false;
  let commandFullyParsed = false;
  let turnResult: TurnResult | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    input.requestOptions
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
      newSessionId = await sessionIdAfterResult(input, msg, newSessionId);
      if (await reportFailedResult(input, msg, newSessionId)) return;
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
        input.codebases,
        input.workflows.map(ws => ws.workflow)
      )
    : NO_COMMANDS;
  if (await routeScannedCommand(input, commands, fullResponse)) return;

  // Text was already streamed — nothing more to send.
  await completeChatTurn(input, fullResponse, turnResult);
}

// ─── Batch Mode ─────────────────────────────────────────────────────────────

/**
 * Batch mode: accumulate all chunks, filter tool indicators, send final clean summary.
 * Used by Slack, GitHub, Discord (batch), and CLI.
 */
export async function handleBatchMode(input: ChatTurnInput): Promise<void> {
  const { commandScan, platform, conversationId, aiClient, fullPrompt, cwd, session } = input;
  const allChunks: { type: string; content: string }[] = [];
  const assistantMessages: string[] = [];
  let assistantChunksTruncated = false;
  let totalChunksTruncated = false;
  let newSessionId: string | undefined;
  let commandDetected = false;
  let commandFullyParsed = false;
  let turnResult: TurnResult | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    input.requestOptions
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
      newSessionId = await sessionIdAfterResult(input, msg, newSessionId);
      if (await reportFailedResult(input, msg, newSessionId)) return;
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
        input.codebases,
        input.workflows.map(ws => ws.workflow)
      )
    : NO_COMMANDS;
  if (await routeScannedCommand(input, commands, finalMessage)) return;

  // No orchestrator commands — send the clean response
  getLog().debug({ messageLength: finalMessage.length }, 'sending_final_message');
  await platform.sendMessage(conversationId, finalMessage);
  await completeChatTurn(input, finalMessage, turnResult);
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
