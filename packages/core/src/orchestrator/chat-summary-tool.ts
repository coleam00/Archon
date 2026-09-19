import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import { getConversationById, updateConversationBrief } from '../db/conversations';

const log = createLogger('orchestrator.update_chat_summary');

/** Longest summary the column accepts; the API enforces the same bound. */
const MAX_SUMMARY = 2000;

/**
 * Longest any one part may be. Three of these plus the JSON envelope sit
 * comfortably inside MAX_SUMMARY, and a part longer than this is a paragraph
 * rather than the one-line answer the field asks for.
 *
 * Mirrors the console's MAX_BRIEF_PART.
 */
const MAX_PART = 600;

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
    doing: {
      kind: 'string',
      description:
        "What we are trying to do, in one or two sentences. Plain language a twelve-year-old could follow, no ticket numbers or jargon. Good: 'Making the chat list down the side, so you can see every chat at once.' Bad: 'Implementing #3390 ConversationRail.'",
    },
    where: {
      kind: 'string',
      description:
        "Where the work actually stands right now. Good: 'Built, but not switched on here — it needs the server restarted first.' Leave it out if the work has not started.",
    },
    left: {
      kind: 'string',
      description:
        'What is still outstanding, and anything the user has to do themselves. Leave it out if nothing is.',
    },
    clear: {
      kind: 'boolean',
      description:
        'Set true to remove the summary entirely, for a chat that turned out to be a one-off. Omit the other fields when using this.',
    },
    rewrite_pinned: {
      kind: 'boolean',
      description:
        'Set true ONLY when the user has just asked for the summary to be updated or rewritten. A summary the user wrote themselves is otherwise left alone, and this is how their ask overrides that. Never set it on your own initiative.',
    },
    summary: {
      kind: 'string',
      description:
        'Deprecated — prefer the three fields above. Accepted as `doing` so a call written against the older single-field shape still works.',
    },
  },
  // Nothing is required at the schema level: every part is documented as
  // optional and `clear` takes none of them, so requiring one would have a
  // provider reject a documented call before the handler could run. The handler
  // enforces the real rule — `clear`, or at least one part.
  required: [],
});

/**
 * The stored shape. Mirrored by the console's `primitives/brief.ts`, which may
 * not import production modules (ESLint isolation rule), so the two must change
 * together — the key names are the contract between them.
 */
interface StoredBrief {
  doing: string;
  where: string;
  left: string;
}

function readPart(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_PART) : '';
}

/**
 * Serialize within the bound the API and column share.
 *
 * Capping each part by character count is not enough: JSON escaping expands
 * text the cap counted as short — every quote and newline becomes two
 * characters — so a model that answers entirely in quoted speech could still
 * produce a payload the write rejects. Trim the longest part until it fits,
 * which keeps the shorter answers whole.
 */
function serializeBrief(brief: StoredBrief): string {
  const parts: StoredBrief = { ...brief };
  let json = JSON.stringify(parts);
  while (json.length > MAX_SUMMARY) {
    const over = json.length - MAX_SUMMARY;
    const key = (['doing', 'where', 'left'] as const).reduce((a, b) =>
      parts[a].length >= parts[b].length ? a : b
    );
    if (parts[key].length === 0) break;
    parts[key] = parts[key].slice(0, Math.max(0, parts[key].length - over));
    json = JSON.stringify(parts);
  }
  return json;
}

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
      "Rewrite this chat's short summary as three separate answers — `doing` (what we're doing), `where` (where we are), `left` (what's left) — so the user can see at a glance where they left off. Each is optional: a throwaway question needs one line, not an empty skeleton. Call it when the state of the work changes (a decision made, a piece finished, a direction abandoned), NOT on every turn. Always rewrite the whole thing, never add to what is there. Plain language, no jargon. Leaves a summary the user edited themselves alone unless they ask — then call again with `rewrite_pinned`.",
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const clear = input.clear === true;
      const brief: StoredBrief = {
        // `summary` folds into the first part rather than being rejected: a
        // call written against the older single-field shape should still land
        // somewhere readable instead of silently doing nothing.
        doing: readPart(input.doing) || readPart(input.summary),
        where: readPart(input.where),
        left: readPart(input.left),
      };
      const empty = brief.doing === '' && brief.where === '' && brief.left === '';

      if (!clear && empty) {
        return 'update_chat_summary error: give at least one of `doing`, `where` or `left`, or set `clear` to true.';
      }

      const conv = await getConversationById(ctx.conversationDbId);
      if (conv === null) {
        log.warn({ conversationId: ctx.conversationDbId }, 'conversation_not_found');
        return 'update_chat_summary error: this conversation no longer exists.';
      }

      // The user's own words win unless they asked for them to be replaced.
      // Without the override the only way past the pin was to clear first and
      // write second, which destroys the summary in between — so an interrupted
      // rewrite left the chat with nothing.
      if (conv.brief_pinned && !clear && input.rewrite_pinned !== true) {
        return 'Not updated: the user edited this summary themselves, so it is left as they wrote it. If they asked for it to be rewritten, call again with `rewrite_pinned` set to true.';
      }

      const stored = clear ? null : serializeBrief(brief);
      // Written by the agent, so the pin comes off even when a rewrite was
      // asked for: leaving it set would claim the user wrote these words.
      await updateConversationBrief(conv.id, stored, false);
      log.info(
        { conversationId: conv.id, cleared: clear, length: stored?.length ?? 0 },
        'summary_written'
      );
      return clear
        ? 'Summary cleared.'
        : `Summary updated. What we are doing: ${brief.doing || '(blank)'} Where we are: ${brief.where || '(blank)'} What's left: ${brief.left || '(blank)'}`;
    },
  };
}
