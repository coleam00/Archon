/**
 * AI-powered conversation title generator
 *
 * Generates concise 3-6 word titles using the configured AI assistant.
 * Resolves the `small` tier from the AI profile (so users with custom tier
 * config get cheap-and-fast titling automatically); falls back to the
 * TITLE_GENERATION_MODEL env var, then the SDK default.
 * Designed to be fire-and-forget — never throws, all errors logged internally.
 */
import { getAgentProvider } from '@archon/providers';
import * as conversationDb from '../db/conversations';
import { createLogger } from '@archon/paths';
import { loadConfig } from '../config/config-loader';
import { buildAiProfile, isLiteralSpec, resolveModelSpec } from '@archon/workflows/model-resolver';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('service.title-generator');
  return cachedLog;
}

/** Maximum title length in the database */
const MAX_TITLE_LENGTH = 100;

/**
 * Generate and save a conversation title using AI.
 *
 * Fire-and-forget safe — catches all errors internally.
 *
 * @param conversationDbId - Database UUID of the conversation
 * @param userMessage - The user's message to generate a title from
 * @param assistantType - Provider identifier (e.g. 'claude', 'codex')
 * @param cwd - Working directory for the AI client
 * @param workflowName - Optional workflow name for additional context
 * @param assistantConfig - Optional provider-specific defaults for the selected assistant
 */
export async function generateAndSetTitle(
  conversationDbId: string,
  userMessage: string,
  assistantType: string,
  cwd: string,
  workflowName?: string,
  assistantConfig?: Record<string, unknown>
): Promise<void> {
  try {
    getLog().debug({ conversationDbId, assistantType }, 'title.generate_started');

    // Resolve the `small` tier from the AI profile (cheapest/fastest tier).
    // Cross-provider switching is not supported here — we only use the tier
    // model when its provider matches `assistantType`. Falls back to
    // TITLE_GENERATION_MODEL env var, then SDK default. Best-effort: any
    // failure is silent so titling never blocks a conversation.
    let titleModel: string | undefined;
    try {
      const cfg = await loadConfig(cwd);
      const profile = buildAiProfile(assistantType, {
        globalAliases: cfg.aliases,
        globalTiers: cfg.tiers,
      });
      const spec = resolveModelSpec(profile, 'small');
      if (isLiteralSpec(spec)) {
        titleModel = spec.literal;
      } else if (spec.provider === assistantType) {
        titleModel = spec.model;
      }
    } catch (err) {
      getLog().debug({ err, assistantType }, 'title.tier_resolution_skipped');
    }
    if (titleModel === undefined && process.env.TITLE_GENERATION_MODEL) {
      titleModel = process.env.TITLE_GENERATION_MODEL;
    }

    // Build the title generation prompt
    const titlePrompt = buildTitlePrompt(userMessage, workflowName);

    // Use the configured AI client with no tools (pure text generation)
    const client = getAgentProvider(assistantType);
    let generatedTitle = '';

    for await (const chunk of client.sendQuery(titlePrompt, cwd, undefined, {
      model: titleModel,
      assistantConfig,
      nodeConfig: { allowed_tools: [] }, // No tool access — pure text generation
    })) {
      if (chunk.type === 'assistant') {
        generatedTitle += chunk.content;
      }
    }

    // Clean up the generated title
    const title = cleanTitle(generatedTitle);

    if (!title) {
      getLog().warn({ conversationDbId, raw: generatedTitle }, 'title.generate_empty');
      const fallback = truncateMessage(userMessage);
      await conversationDb.updateConversationTitle(conversationDbId, fallback);
      return;
    }

    await conversationDb.updateConversationTitle(conversationDbId, title);
    getLog().info({ conversationDbId, title }, 'title.generate_completed');
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, conversationDbId }, 'title.generate_failed');
    // Fire-and-forget — do NOT re-throw.
    // Fallback: try to set a truncated message title
    try {
      const fallback = truncateMessage(userMessage);
      await conversationDb.updateConversationTitle(conversationDbId, fallback);
      getLog().info({ conversationDbId, title: fallback }, 'title.fallback_set');
    } catch (_fallbackErr: unknown) {
      // Double failure — just log and move on
      getLog().warn({ conversationDbId }, 'title.fallback_also_failed');
    }
  }
}

/**
 * Build the prompt for title generation
 */
function buildTitlePrompt(userMessage: string, workflowName?: string): string {
  const context = workflowName ? `\nWorkflow: ${workflowName}` : '';

  return `Generate a concise conversation title (3-6 words) for this user message. The title should capture the essence of what the user is asking or doing. Return ONLY the title text, nothing else — no quotes, no punctuation at the end, no explanation.
${context}
User message: ${userMessage.slice(0, 500)}`;
}

/**
 * Clean up the AI-generated title
 * - Strip quotes, extra whitespace, trailing punctuation
 * - Enforce length limit
 */
function cleanTitle(raw: string): string {
  let cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, '') // Strip surrounding quotes
    .replace(/^Title:\s*/i, '') // Strip "Title: " prefix
    .replace(/[.!?]+$/, '') // Strip trailing punctuation
    .replace(/\n.*/s, '') // Take only first line
    .trim();

  if (cleaned.length > MAX_TITLE_LENGTH) {
    cleaned = cleaned.slice(0, MAX_TITLE_LENGTH - 3) + '...';
  }

  return cleaned;
}

/**
 * Truncate a user message for use as a fallback title
 */
function truncateMessage(message: string): string {
  return message.length > MAX_TITLE_LENGTH
    ? message.slice(0, MAX_TITLE_LENGTH - 3) + '...'
    : message;
}
