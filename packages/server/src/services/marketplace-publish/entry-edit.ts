/**
 * PURE, text-based editor for the upstream `packages/docs-web/src/data/marketplace.ts`
 * source (S4). Parses `marketplaceEntries` by brace-depth scanning (no `import()` —
 * the runtime source of truth is upstream `dev`'s fetched text, not this checkout),
 * decides append/update/collision by slug + case-insensitive author match, and emits
 * a Prettier-stable entry block (spike-verified against the repo's `.prettierrc`:
 * printWidth 100, singleQuote, trailingComma es5).
 *
 * Also replicates the 6 stable field checks from
 * `packages/docs-web/scripts/lint-marketplace.ts:19-49` (S2) — that script
 * statically imports `marketplaceEntries` from THIS checkout, so it can't be
 * shelled against an arbitrary edited text; true reuse would require mutating
 * the server's own working tree.
 */

const ARRAY_DECL_RE = /export const marketplaceEntries: MarketplaceEntry\[\] = \[/;
const PRINT_WIDTH = 100;

/** A candidate entry to append or use as the update payload (never includes `featured`). */
export interface MarketplaceEntryCandidate {
  slug: string;
  name: string;
  author: string;
  description: string;
  sourceUrl: string;
  sha: string;
  tags: string[];
  archonVersionCompat: string;
}

export interface ParsedEntry {
  slug: string;
  author: string;
  /** Index of this entry's opening `{` in the full source text. */
  start: number;
  /** Index just past this entry's closing `}` in the full source text. */
  end: number;
  /** Raw entry object text (`{ ... }`, no trailing comma). */
  text: string;
}

export interface ParsedMarketplaceSource {
  entries: ParsedEntry[];
  /** Index of the `[` that opens the `marketplaceEntries` array. */
  arrayOpenIndex: number;
  /** Index of the matching `]` that closes the array. */
  arrayCloseIndex: number;
}

/**
 * Parse `marketplaceEntries` out of fetched `marketplace.ts` source text.
 * Entry blocks are found by brace-depth scanning inside the array span (so
 * `tags: [...]` and other bracketed content inside an entry never confuses the
 * scan); each entry's `slug`/`author` are extracted with the same
 * single-quoted-literal regexes the auto-review's `parse-entry` node uses —
 * quoted on every entry today, including coleam00's own (which use unquoted
 * `sha: SHA` / template-literal `sourceUrl`, but always a quoted `slug`/`author`).
 * Both scans are string-literal-aware (backslash-escape aware) so a `{`/`}`/
 * `[`/`]` character inside a field VALUE (e.g. a description mentioning JSON
 * or template syntax) can never be mistaken for structural punctuation.
 */
export function parseEntries(sourceText: string): ParsedMarketplaceSource {
  const declMatch = ARRAY_DECL_RE.exec(sourceText);
  if (!declMatch) {
    throw new Error(
      'Could not locate "export const marketplaceEntries: MarketplaceEntry[] = [" in the fetched marketplace.ts source.'
    );
  }
  const arrayOpenIndex = declMatch.index + declMatch[0].length - 1; // index of '['

  // String-literal-aware scan state, threaded through both passes below so
  // `isInsideStringAt`'s O(n) rescan isn't needed per-character (O(n^2)).
  let inString = false;
  let quoteChar = '';
  function stepString(ch: string): boolean {
    if (inString) {
      if (ch === quoteChar) inString = false;
      return true;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      quoteChar = ch;
      return true;
    }
    return false;
  }

  let bracketDepth = 0;
  let arrayCloseIndex = -1;
  for (let i = arrayOpenIndex; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === '\\' && inString) {
      i++; // skip the escaped character
      continue;
    }
    if (stepString(ch)) continue;
    if (ch === '[') bracketDepth++;
    else if (ch === ']') {
      bracketDepth--;
      if (bracketDepth === 0) {
        arrayCloseIndex = i;
        break;
      }
    }
  }
  if (arrayCloseIndex === -1) {
    throw new Error('Unterminated marketplaceEntries array — no matching "]" found.');
  }

  const entries: ParsedEntry[] = [];
  let braceDepth = 0;
  let entryStart = -1;
  // Reset string-scan state for the second pass (independent walk).
  inString = false;
  quoteChar = '';
  for (let i = arrayOpenIndex + 1; i < arrayCloseIndex; i++) {
    const ch = sourceText[i];
    if (ch === '\\' && inString) {
      i++;
      continue;
    }
    if (stepString(ch)) continue;
    if (ch === '{') {
      if (braceDepth === 0) entryStart = i;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && entryStart !== -1) {
        const end = i + 1;
        const text = sourceText.slice(entryStart, end);
        const slug = /slug:\s*'([^']+)'/.exec(text)?.[1];
        const author = /author:\s*'([^']+)'/.exec(text)?.[1];
        if (slug !== undefined && author !== undefined) {
          entries.push({ slug, author, start: entryStart, end, text });
        }
        entryStart = -1;
      }
    }
  }

  return { entries, arrayOpenIndex, arrayCloseIndex };
}

export type EntryAction =
  | { kind: 'append' }
  | { kind: 'update'; existing: ParsedEntry }
  | { kind: 'collision'; existing: ParsedEntry };

/** Decide append/update/collision — slug match, then case-insensitive author compare. */
export function decideAction(entries: ParsedEntry[], slug: string, login: string): EntryAction {
  const existing = entries.find(e => e.slug === slug);
  if (!existing) return { kind: 'append' };
  return existing.author.toLowerCase() === login.toLowerCase()
    ? { kind: 'update', existing }
    : { kind: 'collision', existing };
}

function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Emit one field as Prettier would: inline if `<indent>field: 'value',` fits
 * printWidth (100), else wrapped with a 2-space-deeper continuation line
 * (S4 emitter rule, spike-verified against `.prettierrc`).
 */
function emitStringField(field: string, value: string, indent: string): string {
  const escaped = escapeSingleQuoted(value);
  const inline = `${indent}${field}: '${escaped}',`;
  if (inline.length <= PRINT_WIDTH) return inline;
  return `${indent}${field}:\n${indent}  '${escaped}',`;
}

/**
 * Emit a full entry block in the spike-verified field order (slug, name,
 * author, description, sourceUrl, sha, tags, archonVersionCompat). `featured`
 * is never emitted — it's a maintainer-curated flag, not something a
 * service-authored submission sets.
 */
export function emitEntry(candidate: MarketplaceEntryCandidate): string {
  const tagsLiteral = `[${candidate.tags.map(t => `'${escapeSingleQuoted(t)}'`).join(', ')}]`;
  return [
    '  {',
    emitStringField('slug', candidate.slug, '    '),
    emitStringField('name', candidate.name, '    '),
    emitStringField('author', candidate.author, '    '),
    emitStringField('description', candidate.description, '    '),
    emitStringField('sourceUrl', candidate.sourceUrl, '    '),
    emitStringField('sha', candidate.sha, '    '),
    `    tags: ${tagsLiteral},`,
    emitStringField('archonVersionCompat', candidate.archonVersionCompat, '    '),
    '  },',
  ].join('\n');
}

/**
 * Apply an append or update to the fetched source text. Throws on `collision`
 * — callers must short-circuit on collision (S6: before any write) and never
 * reach this function with one.
 *
 * UPDATE touches ONLY the matched entry block's `sha` literal and the sha
 * embedded in `sourceUrl` — they are the same 40-hex string (S4), so a single
 * substring replace within the entry's own text handles both, plus a refresh
 * of `archonVersionCompat`. No other field changes.
 */
export function applyEdit(
  sourceText: string,
  parsed: ParsedMarketplaceSource,
  action: EntryAction,
  candidate: MarketplaceEntryCandidate
): string {
  if (action.kind === 'collision') {
    throw new Error(
      `Cannot apply edit for slug "${action.existing.slug}": owned by a different author. ` +
        'Callers must short-circuit on collision before calling applyEdit.'
    );
  }

  if (action.kind === 'append') {
    const insertion = `${emitEntry(candidate)}\n`;
    return (
      sourceText.slice(0, parsed.arrayCloseIndex) +
      insertion +
      sourceText.slice(parsed.arrayCloseIndex)
    );
  }

  const { existing } = action;
  const oldSha = /sha:\s*'([0-9a-f]{40})'/.exec(existing.text)?.[1];
  if (!oldSha) {
    throw new Error(
      `Cannot update entry "${existing.slug}": no quoted 40-hex "sha" literal found to replace.`
    );
  }
  let updatedEntryText = existing.text.split(oldSha).join(candidate.sha);
  updatedEntryText = updatedEntryText.replace(
    /archonVersionCompat:\s*'[^']*'/,
    `archonVersionCompat: '${escapeSingleQuoted(candidate.archonVersionCompat)}'`
  );

  return sourceText.slice(0, existing.start) + updatedEntryText + sourceText.slice(existing.end);
}

/**
 * Replicate `lint-marketplace.ts:19-49`'s 6 per-entry field checks (S2) —
 * everything except the network source-existence check, which the publish
 * flow instead satisfies with a post-commit `repos.getContent` probe.
 * `existingSlugs` should exclude the candidate's own slug on an update.
 */
export function lintEntry(
  candidate: MarketplaceEntryCandidate,
  existingSlugs: readonly string[]
): string[] {
  const issues: string[] = [];
  const prefix = `[${candidate.slug}]`;

  if (existingSlugs.includes(candidate.slug)) {
    issues.push(`Duplicate slug: '${candidate.slug}'`);
  }
  if (!candidate.slug || !/^[a-z0-9-]+$/.test(candidate.slug)) {
    issues.push(`${prefix} slug must be lowercase alphanumeric with hyphens only`);
  }
  if (!candidate.name.trim()) issues.push(`${prefix} name is required`);
  if (!candidate.author.trim()) issues.push(`${prefix} author is required`);
  if (!candidate.description.trim()) issues.push(`${prefix} description is required`);
  if (!candidate.sha || !/^[0-9a-f]{40}$/.test(candidate.sha)) {
    issues.push(`${prefix} sha must be a full 40-char lowercase hex SHA`);
  }
  if (!candidate.archonVersionCompat.trim()) {
    issues.push(`${prefix} archonVersionCompat is required`);
  }
  if (candidate.tags.length === 0) issues.push(`${prefix} must have at least one tag`);
  if (!candidate.sourceUrl.startsWith('https://github.com/')) {
    issues.push(`${prefix} sourceUrl must start with https://github.com/`);
  }

  return issues;
}
