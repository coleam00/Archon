import { describe, expect, test } from 'bun:test';
import type { PackView } from '../api';
import { shippedFile } from '../curated.test-fixtures';
import { mapSource } from './map-source';

const PATH = '/packs/acme/flow/.shared/factory-view.json';

/** The note a derived source carries; fails when the source is not derived with a note. */
function noteOf(source: ReturnType<typeof mapSource>): string {
  if (source.kind !== 'derived' || source.note === null) throw new Error(`no note: ${source.kind}`);
  return source.note;
}
type Problem = PackView['problems'][number];
const problem = (severity: Problem['severity'], message: string): Problem => ({
  severity,
  path: [],
  message,
});

describe('which map a view read draws', () => {
  test('nothing is chosen before the read answers, so the derived map never flashes first', () => {
    expect(mapSource({})).toEqual({ kind: 'loading' });
  });

  test('a file that read and checked clean draws the curated map', () => {
    expect(mapSource({ data: { path: PATH, view: shippedFile, problems: [] } })).toEqual({
      kind: 'curated',
      path: PATH,
      view: shippedFile,
      warnings: [],
    });
  });

  test('warnings only still draw the curated map, carrying the warnings', () => {
    const warning = problem('warning', 'stage "discoveries" is on no map card');
    const source = mapSource({ data: { path: PATH, view: shippedFile, problems: [warning] } });
    expect(source).toMatchObject({ kind: 'curated', warnings: [warning] });
  });

  test('a pack that ships no file draws the derived map with no note', () => {
    expect(mapSource({ data: { path: null, view: null, problems: [] } })).toEqual({
      kind: 'derived',
      note: null,
    });
  });

  test('a file that did not read draws the derived map and says why', () => {
    const note = noteOf(
      mapSource({
        data: { path: PATH, view: null, problems: [problem('error', 'is not JSON: oops')] },
      })
    );
    expect(note).toContain('is not JSON: oops');
  });

  test('a file with an error against the graph draws the derived map, naming the first three once each', () => {
    const errors = ['a', 'a', 'b', 'c', 'd', 'e'].map(name =>
      problem('error', `names step "${name}"`)
    );
    const note = noteOf(
      mapSource({
        data: { path: PATH, view: shippedFile, problems: [problem('warning', 'w'), ...errors] },
      })
    );
    for (const named of ['"a"', '"b"', '"c"']) expect(note).toContain(named);
    expect(note).not.toContain('"d"');
    expect(note.split('"a"')).toHaveLength(2);
  });

  test('the note names the file within the pack, not where it is installed', () => {
    const note = noteOf(
      mapSource({
        data: {
          path: 'C:\\home\\plugins\\packs\\o\\p\\abc\\.shared\\factory-view.json',
          view: null,
          problems: [problem('error', 'is not JSON: oops')],
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
