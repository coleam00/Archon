import type { FactoryPackSettings } from '../../skills/factory';

type Setting = FactoryPackSettings['settings'][number];
type Section = FactoryPackSettings['sections'][number];
type ProjectSettings = FactoryPackSettings['projects'][number];

/** A section of the Settings page with its settings; `section` null is the trailing "Other". */
export interface SettingGroup {
  id: string;
  section: Section | null;
  settings: Setting[];
}

/** The id of the section that holds every setting the overview's map puts in none. */
export const OTHER_SECTION = 'other';

/**
 * The Settings page's sections (DESIGN.md, owner change 6 of 2026-11-21): the overview's
 * `setting_sections` in their order, each with its settings in the declaration's order, then
 * "Other" with every setting whose section is unnamed or not listed, so a pack update never
 * hides one. A section with no setting is left out.
 */
export function groupSettings(
  settings: readonly Setting[],
  sections: readonly Section[]
): SettingGroup[] {
  const listed = new Set(sections.map(section => section.id));
  const groups: SettingGroup[] = sections.map(section => ({
    id: section.id,
    section,
    settings: settings.filter(setting => setting.section === section.id),
  }));
  groups.push({
    id: OTHER_SECTION,
    section: null,
    settings: settings.filter(setting => setting.section === null || !listed.has(setting.section)),
  });
  return groups.filter(group => group.settings.length > 0);
}

/** The header band's figures; `set` and `packDefault` are null when no project's file is read. */
interface SettingCounts {
  total: number;
  set: number | null;
  packDefault: number | null;
  shadows: number;
}

/**
 * How many settings there are, how many `project` sets, how many fall back to the pack's
 * default (empty or unset), and how many are shadows today.
 */
export function settingCounts(
  settings: readonly Setting[],
  project: ProjectSettings | undefined
): SettingCounts {
  const total = settings.length;
  const shadows = settings.filter(setting => setting.shadow).length;
  if (project === undefined || project.error !== null)
    return { total, set: null, packDefault: null, shadows };
  const set = settings.filter(setting => project.values[setting.name]?.state === 'set').length;
  return { total, set, packDefault: total - set, shadows };
}
