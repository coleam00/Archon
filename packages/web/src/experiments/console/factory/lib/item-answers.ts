import type { components } from '@/lib/api.generated';
import type { FactoryItem } from '../../skills/factory';

type ItemAnswer = FactoryItem['answers'][number];
/**
 * The answer and answerer shapes (`attentionAnswerSchema`, `attentionAnswererSchema`), from
 * the one generated place that carries them without `null`: the generator reads a nullable
 * union, as the item read's `answer` and `by` are, as `unknown`.
 */
type AttentionWait = Extract<components['schemas']['WorkflowWaitContext'], { kind: 'attention' }>;
type AttentionAnswer = NonNullable<AttentionWait['answer']>;
type AttentionAnswerer = NonNullable<AttentionWait['answeredBy']>;
type ItemLink = FactoryItem['links'][number];

/** One recorded answer or ruling, in words. */
interface AnswerLine {
  label: string;
  text: string;
  /** Further lines: the option chosen, the note given with it, who gave it. */
  details: string[];
  at: string;
  runId: string | null;
  /** A withdrawn ruling or ask: shown, struck through. */
  withdrawn: boolean;
}

/**
 * An item read's `answer` or `by`, typed. The item read parses each with the schema these
 * types are generated from (a value that does not parse reads as null), so only the
 * generated type lost the shape.
 */
const answerOf = (value: unknown): AttentionAnswer | null => value as AttentionAnswer | null;
const answererOf = (value: unknown): AttentionAnswerer | null => value as AttentionAnswerer | null;

/** The free text an answer carries (every form has one); null when it is blank. */
function answerText(value: unknown): string | null {
  const text = answerOf(value)?.text ?? '';
  return text.trim() === '' ? null : text;
}

/** Who answered, as the read records them; null when unsaid. */
export function answererName(value: unknown): string | null {
  const answerer = answererOf(value);
  if (answerer === null) return null;
  return 'declared' in answerer ? answerer.declared : 'a signed-in user';
}

const by = (value: unknown): string[] => {
  const name = answererName(value);
  return name === null ? [] : [`by ${name}`];
};

const present = (lines: (string | null)[]): string[] =>
  lines.filter((line): line is string => line !== null);

export function describeAnswer(entry: ItemAnswer): AnswerLine {
  const at = entry.at;
  switch (entry.kind) {
    case 'ruling':
      return {
        label: entry.withdrawn === null ? 'Ruling' : 'Ruling, withdrawn',
        text: entry.text,
        details: by(entry.by),
        at,
        runId: null,
        withdrawn: entry.withdrawn !== null,
      };
    case 'ask':
      return {
        label: entry.withdrawn ? 'Ask withdrawn' : 'Ask answered',
        text: entry.question,
        details: [
          ...present([entry.chosen?.does ?? null, answerText(entry.answer)]),
          ...by(entry.by),
        ],
        at,
        runId: entry.runId,
        withdrawn: entry.withdrawn,
      };
    case 'asks_settled':
      return {
        label: 'Asks settled',
        text: `${entry.answered.toString()} answered, ${entry.withdrawn.toString()} withdrawn`,
        details: [],
        at,
        runId: entry.runId,
        withdrawn: false,
      };
    case 'gate':
      return {
        label: 'Gate',
        text: entry.decision ?? 'resolved',
        details: present([entry.text]),
        at,
        runId: entry.runId,
        withdrawn: false,
      };
    case 'attention':
      return {
        label: 'Answer',
        text: answerText(entry.answer) ?? 'answered, with no text',
        details: by(entry.by),
        at,
        runId: entry.runId,
        withdrawn: false,
      };
  }
}

const LINK_WORDS: Record<ItemLink['kind'], Record<ItemLink['direction'], string>> = {
  depends_on: { outgoing: 'Depends on', incoming: 'Needed by' },
  part_of: { outgoing: 'Part of', incoming: 'Has part' },
  duplicate_of: { outgoing: 'Duplicate of', incoming: 'Duplicated by' },
};

/** A link in plain words, from this item's side. */
export function linkWords(link: Pick<ItemLink, 'kind' | 'direction'>): string {
  return LINK_WORDS[link.kind][link.direction];
}
