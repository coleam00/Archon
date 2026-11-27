import { describe, expect, test } from 'bun:test';
import type { PackView } from '../api';
import { testFile } from '../curated.test-fixtures';
import { mapSource } from './map-source';

const PATH = '/packs/acme/flow/.shared/factory-view.json';

/** The note a derived source carries; fails when the source is not derived with a note. */
function noteOf(source: ReturnType<typeof mapSource>): string {
  if (source.kind !== 'derived' || source.note === null) throw new Error(`no note: ${source.kind}`);
  return source.note;
}
type Problem = PackView['problems'][number];
const problem = (kind: Problem['kind'], message: string): Problem => ({ kind, path: [], message });

describe('which map a view read draws', () => {
  test('nothing is chosen before the read answers, so the derived map never flashes first', () => {
    expect(mapSource({})).toEqual({ kind: 'loading' });
  });

  test('a file that read clean draws the curated map', () => {
    expect(mapSource({ data: { path: PATH, view: testFile, problems: [] } })).toEqual({
      kind: 'curated',
      path: PATH,
      view: testFile,
      problems: [],
    });
  });

  test('a file with problems still draws the curated map, carrying every one of them', () => {
    const problems = [
      problem('dropped', 'names stage "stage-check", which pack "p" does not have'),
      problem('unknown', 'is not a key a view file has'),
    ];
    const source = mapSource({ data: { path: PATH, view: testFile, problems } });
    expect(source).toMatchObject({ kind: 'curated', problems });
  });

  test('a pack that ships no file draws the derived map with no note', () => {
    expect(mapSource({ data: { path: null, view: null, problems: [] } })).toEqual({
      kind: 'derived',
      note: null,
      problems: [],
    });
  });

  test('a file that does not read draws the derived map, says so, and keeps its problems', () => {
    const unreadable = problem('unreadable', 'is not JSON: oops');
    const source = mapSource({ data: { path: PATH, view: null, problems: [unreadable] } });
    expect(noteOf(source)).not.toBe('');
    expect(source).toMatchObject({ kind: 'derived', problems: [unreadable] });
  });

  test('the note names the file within the pack, not where it is installed', () => {
    const note = noteOf(
      mapSource({
        data: {
          path: 'C:\\home\\plugins\\packs\\o\\p\\abc\\.shared\\factory-view.json',
          view: null,
          problems: [problem('unreadable', 'is not JSON: oops')],
        },
      })
    );
    expect(note).toContain('.shared/factory-view.json');
    expect(note).not.toContain('plugins');
  });

  test('a failed read draws the derived map and says the read failed', () => {
    expect(noteOf(mapSource({ error: new Error('HTTP 500') }))).toContain('HTTP 500');
  });
});
