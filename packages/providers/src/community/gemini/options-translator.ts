/**
 * Pure translation helpers between Archon's provider contract and the
 * @lrilai/gemini-cli-sdk surface.
 *
 *   translateOptions — SendQueryOptions → SDK QueryOptions
 *   translateChunk   — SDK MessageChunk → Archon MessageChunk
 *   warnIgnoredOptions — dev-mode visibility for options Gemini can't honor
 *
 * Port-time fixes vs the reference adapter (seanrobertwright/Gemini-CLI-SDK
 * adapter-archon): import the SDK types directly (no local mirror), and never
 * emit a `workflow_dispatch` sentinel (that lives in provider.ts in the
 * reference — but neither Claude nor Codex emit it, and the SDK's dispatcher
 * never produces a WorkflowDispatchChunk, so it is dropped entirely).
 */
import type { QueryOptions, MessageChunk as SdkMessageChunk } from '@lrilai/gemini-cli-sdk';
import { createLogger } from '@archon/paths';

import type { MessageChunk, SendQueryOptions } from '../../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.gemini');
  return cachedLog;
}

/** Translate a single SDK chunk into Archon's MessageChunk shape. */
export function translateChunk(sdk: SdkMessageChunk): MessageChunk {
  switch (sdk.type) {
    case 'assistant':
      return { type: 'assistant', content: sdk.content };

    case 'thinking':
      return { type: 'thinking', content: sdk.content };

    case 'system': {
      // SDK system chunks carry subtype/sessionId/model/role/content; flatten
      // to a single readable string so every platform adapter can display it.
      const parts: string[] = [sdk.subtype];
      if (sdk.sessionId) parts.push(`session=${sdk.sessionId}`);
      if (sdk.model) parts.push(`model=${sdk.model}`);
      if (sdk.content) parts.push(sdk.content);
      return { type: 'system', content: parts.join(' ') };
    }

    case 'tool':
      return {
        type: 'tool',
        toolName: sdk.toolName,
        toolInput: sdk.parameters,
        toolCallId: sdk.toolId,
      };

    case 'tool_result': {
      // SDK ToolResultChunk has no toolName; Archon requires the field, so emit
      // an empty string. `error` is a structured object — surface it as text
      // only when there is no normal output.
      const toolOutput =
        sdk.output !== '' ? sdk.output : sdk.error ? JSON.stringify(sdk.error) : '';
      return { type: 'tool_result', toolName: '', toolOutput, toolCallId: sdk.toolId };
    }

    case 'rate_limit':
      // Phase 5 of the SDK throws rate limits rather than emitting them, but the
      // chunk variant still exists in the union — map it defensively.
      return {
        type: 'rate_limit',
        rateLimitInfo: { code: sdk.code, message: sdk.message, status: sdk.status },
      };

    case 'result':
      return {
        type: 'result',
        sessionId: sdk.sessionId,
        stopReason: sdk.stopReason,
      };

    default:
      // WorkflowDispatchChunk (reserved, never emitted) or any future variant —
      // surface as a system message so it is never silently swallowed.
      return {
        type: 'system',
        content: `[gemini:unhandled-chunk:${(sdk as { type: string }).type}]`,
      };
  }
}

/**
 * Build SDK QueryOptions from Archon's SendQueryOptions. Only fields with a
 * faithful SDK equivalent are mapped; everything else is dropped (and surfaced
 * by warnIgnoredOptions in dev mode).
 *
 * Auth note: `env` is forwarded but HOME is never injected — the subprocess
 * inherits the parent process env, so the ambient ~/.gemini credentials resolve.
 */
export function translateOptions(
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  options: SendQueryOptions | undefined,
  resolvedCliPath: string | undefined
): QueryOptions {
  const nodeConfig = options?.nodeConfig;

  // System prompt: top-level wins over nodeConfig. The SDK only accepts a
  // string, so preset/array forms (e.g. Claude's SystemPromptPreset) are dropped.
  const rawSystemPrompt = options?.systemPrompt ?? nodeConfig?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === 'string' ? rawSystemPrompt : undefined;

  const allowedTools = nodeConfig?.allowed_tools;

  return {
    prompt,
    cwd,
    // Headless execution: auto-approve tool use. gemini-cli's interactive
    // approval prompts would otherwise hang a non-interactive workflow.
    approvalMode: 'yolo',
    ...(options?.model !== undefined ? { model: options.model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(resumeSessionId !== undefined ? { session: resumeSessionId } : {}),
    ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
  };
}

/** Tracks already-warned option keys so each is reported at most once. */
const warnedKeys = new Set<string>();

/** @internal Test-only reset for the one-time-warning dedupe set. */
export function resetWarnedKeys(): void {
  warnedKeys.clear();
}

/**
 * Emit one-time dev-mode warnings for options Gemini ignores. Silent in
 * production (gated on NODE_ENV/DEBUG). Never throws.
 */
export function warnIgnoredOptions(options: SendQueryOptions | undefined): void {
  if (!options) return;
  const isDev =
    process.env.NODE_ENV === 'development' || (process.env.DEBUG ?? '').includes('gemini');
  if (!isDev) return;

  const nodeConfig = options.nodeConfig;
  const ignored: string[] = [];

  if (options.maxBudgetUsd !== undefined) ignored.push('maxBudgetUsd');
  if (options.fallbackModel !== undefined) ignored.push('fallbackModel');
  if (options.forkSession !== undefined) ignored.push('forkSession');
  if (options.persistSession !== undefined) ignored.push('persistSession');
  if (options.outputFormat !== undefined) {
    ignored.push('outputFormat (structuredOutput unsupported in v1)');
  }
  if (nodeConfig?.mcp !== undefined) ignored.push('nodeConfig.mcp (MCP unsupported in v1)');
  if (nodeConfig?.denied_tools !== undefined) {
    ignored.push('nodeConfig.denied_tools (no SDK equivalent)');
  }
  if (nodeConfig?.hooks !== undefined) ignored.push('nodeConfig.hooks');
  if (nodeConfig?.skills !== undefined) ignored.push('nodeConfig.skills');
  if (nodeConfig?.agents !== undefined) ignored.push('nodeConfig.agents');
  if (nodeConfig?.effort !== undefined) ignored.push('nodeConfig.effort');
  if (nodeConfig?.thinking !== undefined) ignored.push('nodeConfig.thinking');
  if (nodeConfig?.sandbox !== undefined) ignored.push('nodeConfig.sandbox');

  for (const key of ignored) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      getLog().warn({ option: key }, 'gemini.option_ignored');
    }
  }
}
