import { describe, test, expect } from 'bun:test';
import type { CommandEntry } from '@/lib/api';
import { groupCommandsBySource } from './command-groups';

function cmd(name: string, source: CommandEntry['source']): CommandEntry {
  return { name, source };
}

describe('groupCommandsBySource', () => {
  test('groups by the declared source, project first', () => {
    const groups = groupCommandsBySource([
      cmd('b1', 'bundled'),
      cmd('p1', 'project'),
      cmd('g1', 'global'),
      cmd('b2', 'bundled'),
    ]);

    expect(groups.map(g => g.name)).toEqual(['Project', 'Global', 'Bundled']);
    expect(groups[2]?.commands.map(c => c.name)).toEqual(['b1', 'b2']);
  });

  test('omits empty groups', () => {
    const groups = groupCommandsBySource([cmd('b1', 'bundled')]);
    expect(groups.map(g => g.name)).toEqual(['Bundled']);
  });

  test('an unrecognised name never changes a command’s group', () => {
    // The regression this replaces: a bundled command matching no filename
    // prefix silently landed in an invented "Utilities" bucket. Now the name
    // has no influence at all — only the declared source does.
    const groups = groupCommandsBySource([
      cmd('archon-write-tests', 'bundled'),
      cmd('archon-implement-issue', 'bundled'),
      cmd('totally-unknown-thing', 'bundled'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Bundled');
    expect(groups[0]?.commands).toHaveLength(3);
  });

  test('an unknown source is surfaced under its raw value, never dropped', () => {
    const drifted = { name: 'x', source: 'workspace' } as unknown as CommandEntry;
    const groups = groupCommandsBySource([cmd('p1', 'project'), drifted]);

    expect(groups.map(g => g.name)).toEqual(['Project', 'workspace']);
  });

  test('no commands yields no groups', () => {
    expect(groupCommandsBySource([])).toEqual([]);
  });
});
