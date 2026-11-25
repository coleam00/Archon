/**
 * The one place a factory surface decides which map it draws (DESIGN.md, COMBINED direction:
 * "ONE check where the map is drawn"). A pack that ships a curated view file the server read
 * and checked without an error draws the curated map; every other answer draws the map derived
 * from the pack graph and its document groups. The two are never merged, stage by stage or
 * otherwise. The Overview's map and How it works both call this.
 */
import type { FactoryView, PackView } from '../api';

type Problem = PackView['problems'][number];

/** How many of a broken file's problems the note names before "and N more". */
const NOTE_PROBLEMS = 3;

export type MapSource =
  /** The view read has not answered: draw the map's loading shape, never the derived map first. */
  | { kind: 'loading' }
  /** The pack's curated view file at `path`, read and checked; `warnings` are what it leaves out. */
  | { kind: 'curated'; path: string; view: FactoryView; warnings: Problem[] }
  /**
   * The map derived from the pack graph. `note` is null when the pack ships no view file, and
   * otherwise one line saying why its file is not drawn, so a broken file is never silent.
   */
  | { kind: 'derived'; note: string | null };

/** Which map to draw for one view read, as `useEntity` holds it. */
export function mapSource(read: { data?: PackView; error?: Error }): MapSource {
  const { data, error } = read;
  if (data === undefined)
    return error === undefined
      ? { kind: 'loading' }
      : { kind: 'derived', note: `The pack's factory view could not be read: ${error.message}` };
  if (data.path === null) return { kind: 'derived', note: null };
  const errors = data.problems.filter(problem => problem.severity === 'error');
  if (data.view === null || errors.length > 0)
    return { kind: 'derived', note: brokenFileNote(data.path, errors) };
  return {
    kind: 'curated',
    path: data.path,
    view: data.view,
    warnings: data.problems.filter(problem => problem.severity === 'warning'),
  };
}

/** The file as the pack names it, `.shared/factory-view.json`: its install path says nothing. */
const inPack = (path: string): string => path.split(/[\\/]/).slice(-2).join('/');

/** One line naming a view file the map cannot draw and its first few problems, each once. */
function brokenFileNote(path: string, errors: readonly Problem[]): string {
  const messages = [...new Set(errors.map(problem => problem.message))];
  const named = messages.slice(0, NOTE_PROBLEMS);
  const more = messages.length - named.length;
  const list =
    named.length === 0
      ? 'it did not read'
      : `${named.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''}`;
  return `The pack's factory view (${inPack(path)}) is not drawn: ${list}.`;
}
