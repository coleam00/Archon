/**
 * Display shortening for the long directories a run keeps repeating in its tool calls.
 *
 * The only paths shortened are the ones the server names for the run (`known_paths`),
 * matched as exact substrings. Nothing here reads a command's meaning, and nothing is
 * rewritten: callers render the parts and keep the recorded text for the exact view.
 */
import type { components } from '@/lib/api.generated';

export type KnownPath = components['schemas']['WorkflowRunDetail']['run']['known_paths'][number];

export interface PathToken {
  kind: KnownPath['kind'];
  /** What stands in for the path, e.g. `‹worktree›`. */
  token: string;
  description: string;
  /** The directory as the run recorded it. */
  path: string;
  /**
   * The path as commands spell it. A Windows run records backslashes while its agent's
   * shell commands mostly use forward slashes, so both spellings count.
   */
  spellings: readonly string[];
}

const PATH_TOKENS: Record<KnownPath['kind'], Pick<PathToken, 'token' | 'description'>> = {
  checkout: { token: '‹worktree›', description: "the run's checkout" },
  run_artifacts: { token: '‹run›', description: "this run's artifacts" },
  artifact_runs: {
    token: '‹runs›',
    description: "the artifact directories of this project's runs",
  },
  workflow_source: {
    token: '‹source›',
    description: 'the frozen workflow source this run executes',
  },
};

function withoutTrailingSeparator(path: string): string {
  return path.endsWith('/') || path.endsWith('\\') ? path.slice(0, -1) : path;
}

/** The run's known paths as tokens, longest path first so a nested directory wins. */
export function pathTokens(known: readonly KnownPath[]): PathToken[] {
  const byPath = new Map<string, PathToken>();
  for (const { kind, path: recorded } of known) {
    const path = withoutTrailingSeparator(recorded);
    if (path.length === 0 || byPath.has(path)) continue;
    const spellings = [...new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])];
    byPath.set(path, { kind, path, spellings, ...PATH_TOKENS[kind] });
  }
  return [...byPath.values()].sort((a, b) => b.path.length - a.path.length);
}

/** The `cd <checkout> && ` a command starts with, in any quoting or spelling; '' when none. */
function checkoutPrefix(text: string, tokens: readonly PathToken[]): string {
  for (const token of tokens) {
    if (token.kind !== 'checkout') continue;
    for (const spelling of token.spellings) {
      for (const quote of ['"', "'", '']) {
        const prefix = `cd ${quote}${spelling}${quote} && `;
        if (text.startsWith(prefix)) return prefix;
      }
    }
  }
  return '';
}

const PATH_NAME_CHAR = /[A-Za-z0-9._-]/;

/** One spelling of a token and where it next occurs; `at` is stale once the scan passes it. */
interface Occurrence {
  token: PathToken;
  spelling: string;
  at: number;
}

/**
 * Where `spelling` next occurs as a whole path at or after `from`; Infinity when it does
 * not. A known path followed by more of a file name is a sibling directory
 * (`<checkout>-old`), not the path.
 */
function nextWholePath(text: string, spelling: string, from: number): number {
  let at = text.indexOf(spelling, from);
  while (at !== -1) {
    const next = text[at + spelling.length];
    if (next === undefined || !PATH_NAME_CHAR.test(next)) return at;
    at = text.indexOf(spelling, at + 1);
  }
  return Infinity;
}

/** The first known path at or after `from`; where two start together, the longer path. */
function nextOccurrence(
  text: string,
  from: number,
  occurrences: Occurrence[]
): Occurrence | undefined {
  let first: Occurrence | undefined;
  for (const occurrence of occurrences) {
    if (occurrence.at < from) occurrence.at = nextWholePath(text, occurrence.spelling, from);
    if (occurrence.at !== Infinity && (first === undefined || occurrence.at < first.at)) {
      first = occurrence;
    }
  }
  return first;
}

export type ShortenedPart = string | PathToken;

export interface ShortenedText {
  parts: ShortenedPart[];
  /** The text began with `cd <checkout> && `, which `parts` leaves out. */
  droppedCheckoutPrefix: boolean;
}

/**
 * `text` with every known path replaced by its token and a leading `cd <checkout> && `
 * dropped. `tokens` must be longest path first, as {@link pathTokens} returns them.
 *
 * With `max`, the result is cut to that many displayed characters and ends in an
 * ellipsis when anything was cut. A token is never cut in half: it would no longer read
 * as one. Only the text that can reach the display is searched, so the cost does not
 * grow with the rest of a long value.
 */
export function shortenText(
  text: string,
  tokens: readonly PathToken[],
  max?: number
): ShortenedText {
  const prefix = checkoutPrefix(text, tokens);
  const longestSpelling = Math.max(1, ...tokens.flatMap(t => t.spellings.map(s => s.length)));
  // A displayed character stands for at most one spelling of recorded text.
  const searched =
    max === undefined ? text : text.slice(0, prefix.length + (max + 1) * longestSpelling);
  const occurrences: Occurrence[] = tokens.flatMap(token =>
    token.spellings.map(spelling => ({ token, spelling, at: -1 }))
  );
  const parts: ShortenedPart[] = [];
  let room = max ?? Infinity;
  let at = prefix.length;
  while (at < text.length) {
    const found = nextOccurrence(searched, at, occurrences);
    const literalEnd = Math.min(found?.at ?? text.length, at + room);
    if (literalEnd > at) parts.push(text.slice(at, literalEnd));
    room -= literalEnd - at;
    at = literalEnd;
    if (found === undefined || found.at !== at || found.token.token.length > room) break;
    parts.push(found.token);
    room -= found.token.token.length;
    at += found.spelling.length;
  }
  if (at < text.length) parts.push('…');
  if (parts.length === 0) parts.push('');
  return { parts, droppedCheckoutPrefix: prefix.length > 0 };
}
