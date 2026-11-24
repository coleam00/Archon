import { type ReactElement, useId } from 'react';
import { SlidersHorizontal, type LucideIcon } from 'lucide-react';
import type { FactoryPackSettings } from '../../skills/factory';
import { SectionHeading, type ToneColor } from '../document';
import { groupSettings, type SettingGroup } from '../lib/setting-sections';
import { ICONS, KINDS } from '../overview/overview-kinds';
import { SettingPanel } from './SettingPanel';

type ProjectSettings = FactoryPackSettings['projects'][number];

/**
 * The settings by what they govern (owner change 6 of 2026-11-21), in the sections the overview
 * file's map names, each in its kind's colour and icon; "Other" last, neutral, for any setting
 * the map puts in none.
 */
export function SettingsSections({
  settings,
  project,
}: {
  settings: FactoryPackSettings;
  project: ProjectSettings | undefined;
}): ReactElement[] {
  return groupSettings(settings.settings, settings.sections).map(group => (
    <SettingsSection key={group.id} group={group} project={project} />
  ));
}

/**
 * The setting panels' grid (owner change 6 of 2026-11-21): one across on a phone, two from md,
 * three from about 1800 px. The breakpoint is in rem (112.5rem) because Tailwind sorts a px
 * breakpoint before `md:`, which then wins. Panels are as tall as their content (owner change 5).
 * The page's skeleton draws the same grid.
 */
export const SETTINGS_GRID =
  'grid grid-cols-1 items-start gap-3 md:grid-cols-2 min-[112.5rem]:grid-cols-3';

const OTHER = {
  eyebrow: 'Other',
  title: 'Other settings',
  tone: 'var(--node-opaque)',
  icon: SlidersHorizontal,
} as const satisfies { eyebrow: string; title: string; tone: ToneColor; icon: LucideIcon };

function SettingsSection({
  group,
  project,
}: {
  group: SettingGroup;
  project: ProjectSettings | undefined;
}): ReactElement {
  const headingId = useId();
  const look =
    group.section === null
      ? OTHER
      : {
          eyebrow: group.section.eyebrow,
          title: group.section.title,
          tone: KINDS[group.section.kind].color,
          icon: ICONS[group.section.icon],
        };
  return (
    <section
      data-doc-section=""
      data-section={group.id}
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
    >
      <SectionHeading id={headingId} {...look} count={group.settings.length} />
      <ul className={SETTINGS_GRID}>
        {group.settings.map(setting => (
          <SettingPanel key={setting.name} setting={setting} project={project} tone={look.tone} />
        ))}
      </ul>
    </section>
  );
}
