/**
 * The one place a factory surface decides which map it draws (DESIGN.md, COMBINED direction).
 * The server reads a pack's view file entry by entry and reconciles it with the pack graph, so
 * a view comes back whenever the file reads at all: a stale or broken entry costs only itself
 * and is listed in `problems`. Any view draws the curated map (laid out from the graph, worded
 * by the file) with its problems shown beside it. Only a file that does not read at all, or a
 * view read that failed, draws the map derived from the pack graph, with a note saying why.
 * The two are never merged, stage by stage or otherwise. The Overview's map and How it works
 * both call this.
 */
import type { FactoryView, PackView } from '../api';

export type ViewProblem = PackView['problems'][number];

export type MapSource =
  /** The view read has not answered: draw the map's loading shape, never the derived map first. */
  | { kind: 'loading' }
  /** The pack's view file at `path`, as served; `problems` are what the map works around. */
  | { kind: 'curated'; path: string; view: FactoryView; problems: ViewProblem[] }
  /**
   * The map derived from the pack graph. `note` is null when the pack ships no view file, and
   * otherwise one line saying why its file is not drawn, so a broken file is never silent;
   * `problems` are the file's, when it was read.
   */
  | { kind: 'derived'; note: string | null; problems: ViewProblem[] };

/** Which map to draw for one view read, as `useEntity` holds it. */
export function mapSource(read: { data?: PackView; error?: Error }): MapSource {
  const { data, error } = read;
  if (data === undefined)
    return error === undefined
      ? { kind: 'loading' }
      : {
          kind: 'derived',
          note: `The pack's factory view could not be read: ${error.message}`,
          problems: [],
        };
  if (data.path === null) return { kind: 'derived', note: null, problems: [] };
  if (data.view === null)
    return {
      kind: 'derived',
      note: `The pack's factory view (${inPack(data.path)}) does not read, so the map shows the pack's own names.`,
      problems: data.problems,
    };
  return { kind: 'curated', path: data.path, view: data.view, problems: data.problems };
}

/** The file as the pack names it, `.shared/factory-view.json`: its install path says nothing. */
const inPack = (path: string): string => path.split(/[\\/]/).slice(-2).join('/');
