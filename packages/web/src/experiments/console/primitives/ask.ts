/**
 * Ask blocks — the agent's multiple-choice questions, rendered as something you
 * can click instead of something you have to answer by typing a letter.
 *
 * The agent writes a fenced ```ask block holding JSON. The chat splits a reply
 * on those fences and renders the blocks as cards, leaving the prose around
 * them as ordinary markdown.
 *
 * The fence is the contract, and it degrades safely. A client that does not
 * know about ask blocks — an older bundle, a Telegram relay, a plain-text
 * export — renders the JSON as a code block, which is ugly but complete: every
 * question and option is still legible. Nothing is hidden behind the renderer.
 *
 * Answering is just sending a message. The chat is a conversation, so a click
 * composes the same text a person would have typed and sends it; the agent
 * needs no new channel and no new state. That is also why a whole set of
 * questions is answered in one submission: the answers do not exist anywhere
 * until they are sent, so paging back and changing one costs nothing.
 */

export interface AskOption {
  /** Short label — the choice itself, e.g. "Dead — archive it." */
  label: string;
  /** Optional reasoning shown under the label. */
  detail?: string;
  /** At most one option per question should set this. */
  recommended?: boolean;
  /** Why this one is recommended. Only meaningful with `recommended`. */
  why?: string;
}

export interface AskQuestion {
  /** The question itself. */
  title: string;
  /** Optional evidence paragraph shown above the question. */
  evidence?: string;
  /** Optional label for the subject of the question, shown as a chip. */
  chip?: string;
  options: AskOption[];
  /** Whether to offer a free-text answer. Defaults to true. */
  allowOwn?: boolean;
  /**
   * Whether more than one option can be chosen. Defaults to false — a question
   * asks for a decision, and letting every question take a set would quietly
   * turn "which one" into "which of these", which is a different question.
   */
  multi?: boolean;
}

export interface AskSpec {
  questions: AskQuestion[];
}

/**
 * What one question has been answered with: the chosen option labels, or a
 * single free-text answer. An array even for a single-answer question so the
 * two kinds share one shape.
 */
export type Answer = string[] | null;

/** A reply is a sequence of prose runs and ask cards. */
export type ReplyPart = { kind: 'markdown'; text: string } | { kind: 'ask'; spec: AskSpec };

/**
 * Validate parsed JSON as an {@link AskSpec}.
 *
 * Returns null rather than throwing, and the caller falls back to rendering the
 * block as code. A malformed block must never blank a reply — the text is the
 * thing the user came for, and a question they can read but not click still
 * works.
 */
export function parseAskSpec(raw: string): AskSpec | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const parsed: AskQuestion[] = [];
  for (const q of questions) {
    if (typeof q !== 'object' || q === null) return null;
    const { title, evidence, chip, options, allowOwn, multi } = q as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim().length === 0) return null;
    if (!Array.isArray(options) || options.length === 0) return null;

    const parsedOptions: AskOption[] = [];
    for (const o of options) {
      if (typeof o !== 'object' || o === null) return null;
      const { label, detail, recommended, why } = o as Record<string, unknown>;
      if (typeof label !== 'string' || label.trim().length === 0) return null;
      parsedOptions.push({
        label,
        ...(typeof detail === 'string' ? { detail } : {}),
        ...(recommended === true ? { recommended: true } : {}),
        ...(typeof why === 'string' ? { why } : {}),
      });
    }

    parsed.push({
      title,
      ...(typeof evidence === 'string' ? { evidence } : {}),
      ...(typeof chip === 'string' ? { chip } : {}),
      options: parsedOptions,
      ...(allowOwn === false ? { allowOwn: false } : {}),
      ...(multi === true ? { multi: true } : {}),
    });
  }

  return { questions: parsed };
}

/**
 * A fence line: its indent, its character (backtick or tilde), its length, and
 * whatever info string follows.
 *
 * Markdown lets a fence be any run of three or more backticks or tildes, and a
 * fence is closed only by the same character at the same length or longer.
 * That is what lets this file — and the docs that describe the format —
 * demonstrate an ask block inside a longer fence without the demonstration
 * being mistaken for a real one.
 */
const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;

/**
 * Split a reply into prose and ask cards.
 *
 * Line-based rather than a single regex so an unterminated fence — a block
 * still streaming in, or one the agent truncated — degrades to prose instead of
 * swallowing the rest of the message. A block that does not parse is left as
 * the original text, fences and all, so markdown renders it as code.
 */
export function splitReply(content: string): ReplyPart[] {
  const lines = content.split('\n');
  const parts: ReplyPart[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join('\n');
    if (text.trim().length > 0) parts.push({ kind: 'markdown', text });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const open = FENCE.exec(line);
    // Only an `ask` fence at the top level opens a card. Anything else is an
    // ordinary code block, and is copied through verbatim along with everything
    // it encloses — including an ask fence used as an example.
    if (open?.[3] !== 'ask') {
      if (open !== null) {
        const marker = open[2] ?? '';
        const char = marker[0] ?? '`';
        prose.push(line);
        // Skip to this block's own closing fence: same character, at least as
        // long. Unterminated, the rest of the reply is prose.
        i++;
        for (; i < lines.length; i++) {
          const inner = lines[i] ?? '';
          prose.push(inner);
          const close = FENCE.exec(inner);
          if (
            close !== null &&
            close[3] === '' &&
            (close[2] ?? '').startsWith(char) &&
            (close[2] ?? '').length >= marker.length
          ) {
            break;
          }
        }
        continue;
      }
      prose.push(line);
      continue;
    }

    const marker = open[2] ?? '```';
    const char = marker[0] ?? '`';

    // Collect to the closing fence. Without one, this was not a block.
    const body: string[] = [];
    let closeAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = FENCE.exec(lines[j] ?? '');
      if (
        candidate !== null &&
        candidate[3] === '' &&
        (candidate[2] ?? '').startsWith(char) &&
        (candidate[2] ?? '').length >= marker.length
      ) {
        closeAt = j;
        break;
      }
      body.push(lines[j] ?? '');
    }
    if (closeAt === -1) {
      prose.push(line);
      continue;
    }

    const spec = parseAskSpec(body.join('\n'));
    if (spec === null) {
      // Keep it readable as code rather than dropping the question entirely.
      prose.push(line, ...body, lines[closeAt] ?? '```');
    } else {
      flushProse();
      parts.push({ kind: 'ask', spec });
    }
    i = closeAt;
  }

  flushProse();
  return parts;
}

/**
 * Compose the message an answered set sends back.
 *
 * Written as the person would have typed it, because that is exactly what it
 * is — the agent reads a normal chat message and needs no parser. Numbered to
 * match the order asked, so a set answered out of order still reads in order.
 */
export function composeAnswer(questions: AskQuestion[], answers: Answer[]): string {
  return questions
    .map((q, i) => {
      const chosen = answers[i] ?? [];
      // Several choices are written one per line rather than joined with commas,
      // so an option whose own text contains a comma stays unambiguous.
      const body = chosen.length === 0 ? '(skipped)' : chosen.map(c => c.trim()).join('\n   ');
      return `${String(i + 1)}. ${q.title}\n   ${body}`;
    })
    .join('\n');
}

/** Whether every question has an answer — what gates submission. */
export function isComplete(questions: AskQuestion[], answers: Answer[]): boolean {
  return questions.every((_, i) => {
    const a = answers[i];
    return a?.some(v => v.trim().length > 0) ?? false;
  });
}

/**
 * Toggle or replace a choice.
 *
 * A single-answer question replaces what was there; a multi-answer question
 * adds the choice, or removes it if it was already chosen — so the same click
 * that selects is the one that deselects, and there is no separate way to undo.
 */
export function toggleChoice(current: Answer, value: string, multi: boolean): string[] {
  if (!multi) return [value];
  const chosen = current ?? [];
  return chosen.includes(value) ? chosen.filter(v => v !== value) : [...chosen, value];
}

/**
 * Set the free-text answer, replacing any previous one.
 *
 * Deliberately not {@link toggleChoice}: editing free text is a correction, not
 * an additional choice. Toggling would have left the old text alongside the new
 * on a multi-answer question — and since the card shows the first non-option
 * value, it would still have displayed the old one while submitting both.
 *
 * On a single-answer question the custom text is the whole answer. On a
 * multi-answer one it sits alongside the chosen options, which keep their
 * order.
 */
export function setCustomAnswer(
  current: Answer,
  value: string,
  options: AskOption[],
  multi: boolean
): string[] {
  if (!multi) return [value];
  const kept = (current ?? []).filter(v => options.some(o => o.label === v));
  return value.length > 0 ? [...kept, value] : kept;
}
