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
    byPath.set(path, { kind, path, ...PATH_TOKENS[kind] });
  }
  return [...byPath.values()].sort((a, b) => b.path.length - a.path.length);
}

/**
 * A recorded path as commands spell it. A Windows run records backslashes while its
 * agent's shell commands mostly use forward slashes, so both spellings count.
 */
function spellings(path: string): string[] {
  return [...new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])];
}

const PATH_NAME_CHAR = /[A-Za-z0-9._-]/;

/**
 * The spelling of `token` at `at`, when the path ends there. A known path followed by
 * more of a file name is a sibling directory (`<checkout>-old`), not the path.
 */
function spellingAt(text: string, at: number, token: PathToken): string | undefined {
  return spellings(token.path).find(spelling => {
    if (!text.startsWith(spelling, at)) return false;
    const next = text[at + spelling.length];
    return next === undefined || !PATH_NAME_CHAR.test(next);
  });
}

/** The `cd <checkout> && ` a command starts with, in any quoting or spelling; '' when none. */
function checkoutPrefix(text: string, tokens: readonly PathToken[]): string {
  for (const token of tokens) {
    if (token.kind !== 'checkout') continue;
    for (const spelling of spellings(token.path)) {
      for (const quote of ['"', "'", '']) {
        const prefix = `cd ${quote}${spelling}${quote} && `;
        if (text.startsWith(prefix)) return prefix;
      }
    }
  }
  return '';
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
 */
export function shortenText(text: string, tokens: readonly PathToken[]): ShortenedText {
  const prefix = checkoutPrefix(text, tokens);
  const parts: ShortenedPart[] = [];
  let literalFrom = prefix.length;
  let at = prefix.length;
  while (at < text.length) {
    let matched: { token: PathToken; length: number } | undefined;
    for (const token of tokens) {
      const spelling = spellingAt(text, at, token);
      if (spelling !== undefined) {
        matched = { token, length: spelling.length };
        break;
      }
    }
    if (matched === undefined) {
      at += 1;
      continue;
    }
    if (at > literalFrom) parts.push(text.slice(literalFrom, at));
    parts.push(matched.token);
    at += matched.length;
    literalFrom = at;
  }
  if (literalFrom < text.length || parts.length === 0) parts.push(text.slice(literalFrom));
  return { parts, droppedCheckoutPrefix: prefix.length > 0 };
}

/** `parts` cut to `max` displayed characters, with an ellipsis when anything was cut. */
export function truncateParts(parts: readonly ShortenedPart[], max: number): ShortenedPart[] {
  const kept: ShortenedPart[] = [];
  let room = max;
  for (const part of parts) {
    const shown = typeof part === 'string' ? part : part.token;
    if (shown.length <= room) {
      kept.push(part);
      room -= shown.length;
      continue;
    }
    // A token is never cut in half: it would no longer read as one.
    if (typeof part === 'string' && room > 0) kept.push(part.slice(0, room));
    kept.push('…');
    break;
  }
  return kept;
}
