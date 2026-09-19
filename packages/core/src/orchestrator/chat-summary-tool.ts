import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import { getConversationById, updateConversationBrief } from '../db/conversations';

const log = createLogger('orchestrator.update_chat_summary');

/** Longest summary the column accepts; the API enforces the same bound. */
const MAX_SUMMARY = 2000;

export interface ChatSummaryContext {
  /**
   * Database id of the conversation this turn belongs to.
   *
   * Deliberately not the platform id: uniqueness there is only
   * (platform_type, platform_conversation_id), so the same id on another
   * platform could be selected instead and the summary written to a stranger's
   * chat.
   */
  conversationDbId: string;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    summary: {
      kind: 'string',
      description:
        "The whole summary, rewritten — not an addition to what is there. Three short lines, plain language a twelve-year-old could follow, no ticket numbers or jargon. Cover what we are trying to do, where we are, and what is left. Omit a line that does not apply: a throwaway question needs one sentence, not an empty skeleton. Good: 'Built, but not switched on here. It needs the server restarted first.' Bad: '#3356 held pending server restart.'",
    },
    clear: {
      kind: 'boolean',
      description:
        'Set true to remove the summary entirely, for a chat that turned out to be a one-off. Omit `summary` when using this.',
    },
  },
  // Nothing is required at the schema level: `clear` is documented as omitting
  // `summary`, so requiring it would have a provider reject the documented call
  // before the handler could run. The handler enforces the real rule — one of
  // the two must be present.
  required: [],
});

/**
 * Lets the agent keep a chat's summary current.
 *
 * Why a tool rather than summarising the transcript afterwards: "what's left"
 * is a judgement, not a summary. A model reading the transcript back can say
 * what happened; only the agent doing the work knows what is still outstanding.
 *
 * Deliberately NOT called every turn. A question changes nothing about where
 * the work stands; finishing a piece of it does. Writing on every turn would
 * churn `brief_updated_at` and make the staleness signal meaningless, which is
 * the one part of the feature that stops a stale summary being believed.
 *
 * A summary a human edited is left alone: `brief_pinned` is respected here, so
 * the agent cannot silently replace the user's words. The user can still ask
 * for a rewrite explicitly, which arrives as a normal call and overwrites.
 */
export function buildChatSummaryTool(ctx: ChatSummaryContext): NativeTool {
  return {
    name: 'update_chat_summary',
    description:
      "Rewrite this chat's short summary — what we're doing, where we are, what's left — so the user can see at a glance where they left off. Call it when the state of the work changes (a decision made, a piece finished, a direction abandoned), NOT on every turn. Plain language, no jargon. Leaves a summary the user edited themselves alone unless they ask.",
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const clear = input.clear === true;
      const raw = typeof input.summary === 'string' ? input.summary.trim() : '';

      if (!clear && raw.length === 0) {
        return 'update_chat_summary error: `summary` is required unless `clear` is true.';
      }

      const conv = await getConversationById(ctx.conversationDbId);
      if (conv === null) {
        log.warn({ conversationId: ctx.conversationDbId }, 'conversation_not_found');
        return 'update_chat_summary error: this conversation no longer exists.';
      }

      // The user's own words win. They can still ask for a rewrite, which comes
      // through as a request rather than as the agent overwriting them unasked.
      if (conv.brief_pinned && !clear) {
        return 'Not updated: the user edited this summary themselves, so it is left as they wrote it. Ask them if it should be rewritten.';
      }

      const summary = clear ? null : raw.slice(0, MAX_SUMMARY);
      await updateConversationBrief(conv.id, summary, false);
      log.info(
        { conversationId: conv.id, cleared: clear, length: summary?.length ?? 0 },
        'summary_written'
      );
      return clear ? 'Summary cleared.' : `Summary updated: ${summary ?? ''}`;
    },
  };
}
