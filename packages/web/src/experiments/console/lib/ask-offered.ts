import { humaniseId } from './ask-card';

// What a stage offered in its own words, read back out of an ask's context. A pack whose asks
// must offer fixed routes (the option chosen decides what starts next) keeps the stage's own
// options as prose: one marker sentence, then one `- id: does (cost: ...)` line per option, and
// a recommendation `why` that opens `The stage recommends "<id>".`. This module matches that one
// marker sentence, those lines and that prefix, nothing else, and names no pack outcome
// (DESIGN.md, Visual standard rule 1). Any other wording parses to null or marks nothing, and the
// card renders the context as it always has.
const MARKER = 'The stage offered these, in its own words; say which in your answer:';
// The does may be empty (`- id: `). The cost starts at the first ` (cost: ` from which the line
// still ends in `)`, so it may itself hold parentheses.
const LINE = /^- (\S+?):(?: (.*?))?(?: \(cost: (.+)\))?\s*$/;
const RECOMMENDS = /^The stage recommends "([^"]+)"\./;

export interface OfferedOption {
  id: string;
  /** What choosing it does; '' when the stage did not say. */
  does: string;
  cost?: string;
}

export interface Offered {
  /** The context without the marker line and its list; '' when nothing else was said. */
  rest: string;
  options: OfferedOption[];
  /** The offered id the recommendation's `why` names, when it is one of `options`. */
  recommended?: string;
}

function optionOf(line: string): OfferedOption | undefined {
  const match = LINE.exec(line);
  if (match === null) return undefined;
  const [, id = '', does = '', cost] = match;
  return { id, does: does.trim(), ...(cost === undefined ? {} : { cost }) };
}

/**
 * The offered list in `context`, or null when it holds no marker line, or when anything but
 * option lines follows the marker. The pack always writes the list last, so a line it cannot
 * read (a reworded line, or a `does` or `cost` broken over two lines) means the list is not
 * read at all: the card never shows part of it as the whole.
 */
export function parseOffered(context: string, why?: string): Offered | null {
  const lines = context.split(/\r?\n/);
  const marker = lines.findIndex(line => line.trim() === MARKER);
  if (marker === -1) return null;
  const options: OfferedOption[] = [];
  for (const line of lines.slice(marker + 1)) {
    if (line.trim() === '') continue;
    const option = optionOf(line);
    if (option === undefined) return null;
    options.push(option);
  }
  if (options.length === 0) return null;
  const rest = lines.slice(0, marker).join('\n').trim();
  const named = why === undefined ? undefined : RECOMMENDS.exec(why)?.[1];
  const recommended = options.some(option => option.id === named) ? named : undefined;
  return { rest, options, ...(recommended === undefined ? {} : { recommended }) };
}

/** The answer box's prompt while an offered list shows: which of them the person means. */
export function offeredPlaceholder(offered: Offered): string {
  const names = offered.options.map(option => humaniseId(option.id));
  const last = names.pop();
  const list = names.length === 0 ? (last ?? '') : `${names.join(', ')} or ${last ?? ''}`;
  return `Say which the stage offered you mean: ${list}`;
}
