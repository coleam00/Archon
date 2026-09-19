/** The chat summary, as three separate answers rather than one blob of text. */

/**
 * The three questions a summary answers. Order is the reading order in the
 * modal, and the array is what both the reader and the editor iterate — adding
 * a fourth question means adding it here and nowhere else.
 */
export const BRIEF_PARTS = [
  { key: 'doing', label: 'WHAT WE ARE DOING' },
  { key: 'where', label: 'WHERE WE ARE' },
  { key: 'left', label: "WHAT'S LEFT" },
] as const;

export type BriefPartKey = (typeof BRIEF_PARTS)[number]['key'];

export type Brief = Record<BriefPartKey, string>;

export const EMPTY_BRIEF: Brief = { doing: '', where: '', left: '' };

/**
 * Longest serialized summary the API accepts (`brief: z.string().max(2000)`).
 * Exceeding it is a rejected PATCH, which reaches the user as "could not save
 * the summary" — so the bound is enforced here, before the request.
 */
export const MAX_BRIEF = 2000;

/**
 * Longest any one part may be typed. Three of these plus the JSON envelope sit
 * comfortably inside MAX_BRIEF, and a part longer than this is a paragraph
 * rather than the one-line answer the section asks for.
 */
export const MAX_BRIEF_PART = 600;

/**
 * Read a stored summary.
 *
 * The column is plain TEXT and already holds free-text summaries written before
 * the three-part shape existed, plus whatever the agent's tool writes until it
 * is taught the new shape. So anything that is not the expected JSON object is
 * not corrupt — it is a summary from before, and belongs in the first part
 * rather than being thrown away.
 *
 * Returns null only for genuinely absent summaries, so "no summary yet" and
 * "a summary with empty parts" stay distinguishable.
 */
export function parseBrief(raw: string | null | undefined): Brief | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = tryParseObject(raw);
  if (parsed === null) return { ...EMPTY_BRIEF, doing: raw.trim() };
  const brief: Brief = {
    doing: readPart(parsed.doing),
    where: readPart(parsed.where),
    left: readPart(parsed.left),
  };
  // A JSON object that happens to hold none of our keys — some other writer's
  // payload — would otherwise read as an empty summary, silently hiding text
  // the user did write. Show it as free text instead.
  return isBriefEmpty(brief) ? { ...EMPTY_BRIEF, doing: raw.trim() } : brief;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  // Cheap guard first: most stored summaries are prose, and prose is not worth
  // a try/catch per render.
  if (!raw.trimStart().startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPart(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * What to store. Returns null when every part is blank, so clearing the last
 * box clears the summary rather than storing `{"doing":"","where":"","left":""}`
 * — which would read back as a summary that exists but says nothing.
 */
export function serializeBrief(brief: Brief): string | null {
  const trimmed: Brief = {
    doing: brief.doing.trim(),
    where: brief.where.trim(),
    left: brief.left.trim(),
  };
  if (isBriefEmpty(trimmed)) return null;

  let json = JSON.stringify(trimmed);
  // Bound the serialized string rather than trusting a character cap on the
  // parts: JSON escaping expands text that a cap counted as short (every quote
  // and newline becomes two characters), so text that passed the per-box limit
  // can still serialize past the API's. Trim the longest part until it fits,
  // which keeps the shorter answers whole.
  while (json.length > MAX_BRIEF) {
    const over = json.length - MAX_BRIEF;
    const key = BRIEF_PARTS.map(p => p.key).reduce((a, b) =>
      trimmed[a].length >= trimmed[b].length ? a : b
    );
    if (trimmed[key].length === 0) break;
    trimmed[key] = trimmed[key].slice(0, Math.max(0, trimmed[key].length - over));
    json = JSON.stringify(trimmed);
  }
  return json;
}

export function isBriefEmpty(brief: Brief): boolean {
  return BRIEF_PARTS.every(p => brief[p.key].trim().length === 0);
}

/** Only the parts that were written, for a reader that skips empty sections. */
export function filledParts(brief: Brief): { key: BriefPartKey; label: string; text: string }[] {
  return BRIEF_PARTS.filter(p => brief[p.key].trim().length > 0).map(p => ({
    key: p.key,
    label: p.label,
    text: brief[p.key].trim(),
  }));
}
