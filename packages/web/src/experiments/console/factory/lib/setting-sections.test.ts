import { describe, expect, test } from 'bun:test';
import type { FactoryPackSettings } from '../../skills/factory';
import { groupSettings, OTHER_SECTION, settingCounts } from './setting-sections';

type Setting = FactoryPackSettings['settings'][number];
type Section = FactoryPackSettings['sections'][number];
type ProjectSettings = FactoryPackSettings['projects'][number];

const setting = (name: string, section: string | null, shadow = false): Setting => ({
  name,
  description: null,
  default: '',
  type: 'string',
  shadow,
  pointsTo: null,
  section,
  whenLive: null,
});
const section = (id: string): Section => ({
  id,
  eyebrow: id,
  title: `The ${id} section`,
  kind: 'stage',
  icon: 'scale',
});

const SETTINGS = [
  setting('plan_policy', 'held'),
  setting('admit_policy', 'ahead', true),
  setting('new_policy', null),
  setting('build_policy', 'held'),
  setting('moved_policy', 'gone'),
  setting('checks_file', 'proven', true),
];
const SECTIONS = [section('ahead'), section('held'), section('filed'), section('proven')];

describe('groupSettings', () => {
  const groups = groupSettings(SETTINGS, SECTIONS);

  test('every setting appears exactly once', () => {
    const names = groups.flatMap(group => group.settings.map(s => s.name));
    expect(names.sort()).toEqual(SETTINGS.map(s => s.name).sort());
  });

  test("keeps the map's section order and the declaration's order inside a section, and drops an empty section", () => {
    expect(groups.map(group => group.id)).toEqual(['ahead', 'held', 'proven', OTHER_SECTION]);
    expect(groups[1]?.settings.map(s => s.name)).toEqual(['plan_policy', 'build_policy']);
  });

  test('a setting the map puts in no section, or in one it does not list, lands in Other', () => {
    const other = groups.at(-1);
    expect(other?.section).toBeNull();
    expect(other?.settings.map(s => s.name)).toEqual(['new_policy', 'moved_policy']);
  });

  test('with no sections listed, everything is in Other', () => {
    expect(groupSettings(SETTINGS, []).map(group => group.id)).toEqual([OTHER_SECTION]);
  });
});

describe('settingCounts', () => {
  const project = (values: ProjectSettings['values'], error: string | null = null) => ({
    codebaseId: 'cb-1',
    name: 'web',
    error,
    values,
    undeclared: [],
  });
  const set = { state: 'set' as const, value: 'x', problem: null, file: null };

  test('counts set and pack-default settings, which add up to the total, and the shadows', () => {
    const counts = settingCounts(
      SETTINGS,
      project({ plan_policy: set, admit_policy: set, new_policy: { state: 'empty' } })
    );
    expect(counts).toEqual({ total: 6, set: 2, packDefault: 4, shadows: 2 });
  });

  test('a project whose file could not be read, or none, gives no set or default figures', () => {
    const none = { total: 6, set: null, packDefault: null, shadows: 2 };
    expect(settingCounts(SETTINGS, project({}, 'not valid YAML'))).toEqual(none);
    expect(settingCounts(SETTINGS, undefined)).toEqual(none);
  });
});
