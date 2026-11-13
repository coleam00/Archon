/**
 * God mode's memory: short lessons distilled from finished runs, read back by every
 * mission before it starts.
 *
 * The agent judges what is worth remembering; this module only bounds the memory so it
 * stays small enough to read in full. A memory that grows without limit turns into the
 * "inject every document into every node" failure AGENTS.md warns about, so the learner
 * consolidates it and this cap enforces the ceiling between consolidations.
 */

export const LESSONS_DOC = 'god-mode/lessons';

/** Lessons a mission reads. The learner consolidates well before this is reached. */
export const MAX_LESSONS = 40;

export interface Lesson {
  at: string;
  run: string;
  text: string;
}

export interface LessonsDoc {
  lessons: Lesson[];
}

export function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** New lessons not already remembered verbatim, in order. */
export function fresh(existing: Lesson[], candidates: string[]): string[] {
  const seen = new Set(existing.map((l) => normalise(l.text).toLowerCase()));
  const out: string[] = [];
  for (const c of candidates) {
    const n = normalise(c);
    const key = n.toLowerCase();
    if (n === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** The lessons a mission reads, newest last, as one block of prompt text. */
export function recall(doc: LessonsDoc | null): string {
  const lessons = (doc?.lessons ?? []).slice(-MAX_LESSONS);
  if (lessons.length === 0) return 'No lessons recorded yet. This is one of the first god-mode runs.';
  return lessons.map((l) => `- ${l.text}`).join('\n');
}
