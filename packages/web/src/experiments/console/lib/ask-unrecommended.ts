import type { NeedsYouItem } from './needs-you';

// Why a stage left an ask without a recommendation, read back out of its context. A pack whose
// stage had no basis to choose leaves `recommendation` empty and writes one paragraph opening
// with this marker, giving why. This module matches that one script-written marker and nothing
// else (owner decision 2026-11-23, match-script-marker; DESIGN.md, Visual standard rule 9). It is
// display only: it gates nothing, and an ask without the marker reads a fixed line instead.
const MARKER = 'No recommendation: ';
const PARAGRAPHS = /\n[ \t]*\n/;

interface Unrecommended {
  /** The context without the marker paragraph; '' when nothing else was said. */
  rest: string;
  /** The reason the paragraph gives, trimmed; never empty. */
  why: string;
}

/**
 * The first paragraph of `context` opening exactly with the marker, split from the rest; null
 * when no paragraph does, or when it gives no reason.
 */
export function parseUnrecommended(context: string): Unrecommended | null {
  const paragraphs = context.replaceAll('\r\n', '\n').split(PARAGRAPHS);
  const at = paragraphs.findIndex(paragraph => paragraph.startsWith(MARKER));
  if (at === -1) return null;
  const why = (paragraphs[at] ?? '').slice(MARKER.length).trim();
  if (why === '') return null;
  const rest = paragraphs
    .filter((_, index) => index !== at)
    .join('\n\n')
    .trim();
  return { rest, why };
}

/** What an ask a stage left without a recommendation shows: the line under its tiles, and the context left. */
interface UnrecommendedAsk {
  line: string;
  context: string | undefined;
}

/**
 * For an ask a stage left (`askedIn`) with tiles and no recommendation: the line saying why
 * the stage could not choose, from the marker when its context has one, and the context
 * without that paragraph. Null for every other ask, which renders as it always has: one with a
 * recommendation, an answer only in words, or a run's own paused wait, where no stage chose.
 */
export function unrecommendedOf(ask: NeedsYouItem): UnrecommendedAsk | null {
  if (ask.kind !== 'attention' || ask.askedIn === undefined) return null;
  if (ask.recommendation !== undefined || ask.form === 'message') return null;
  const parsed = ask.context === undefined ? null : parseUnrecommended(ask.context);
  if (parsed === null) return { line: 'The stage could not choose.', context: ask.context };
  return {
    line: `The stage could not choose: ${parsed.why}`,
    context: parsed.rest === '' ? undefined : parsed.rest,
  };
}
