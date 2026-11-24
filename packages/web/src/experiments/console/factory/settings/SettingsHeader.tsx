import type { ReactElement, ReactNode } from 'react';
import type { FactoryPackSettings } from '../../skills/factory';
import { HeaderBand, StatChip } from '../document';
import { settingCounts } from '../lib/setting-sections';

type ProjectSettings = FactoryPackSettings['projects'][number];

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The Settings page's header band (owner change 6 of 2026-11-21): how this project has set up
 * its factory, counted; with no project read, how the pack is set up. It names no other project.
 */
export function SettingsHeader({
  settings,
  packName,
  project,
}: {
  settings: FactoryPackSettings;
  packName: string;
  project: ProjectSettings | undefined;
}): ReactElement {
  const counts = settingCounts(settings.settings, project);
  const chips: ReactNode[] = [
    <StatChip
      key="total"
      figure={counts.total}
      label={plural(counts.total, 'setting', 'settings')}
    />,
  ];
  if (counts.set !== null && counts.packDefault !== null)
    chips.push(
      <StatChip key="set" figure={counts.set} label="set by this project" />,
      <StatChip
        key="default"
        figure={counts.packDefault}
        label={plural(counts.packDefault, 'pack default', 'pack defaults')}
      />
    );
  chips.push(
    <StatChip
      key="shadows"
      figure={counts.shadows}
      label={`${plural(counts.shadows, 'shadow', 'shadows')} today`}
      state="shadow"
    />
  );
  return (
    <HeaderBand
      title={
        project === undefined
          ? `How ${packName} is set up`
          : `How ${project.name} has set up its factory`
      }
      sentence={
        <>
          {project === undefined
            ? `Every setting of ${packName}, grouped by what it governs, with the pack's defaults.`
            : `Every setting of ${packName}, grouped by what it governs: what ${project.name} sets, and where it falls back to the pack.`}
          {/* Where the page reads, quietly: the band replaces the pack page's Source toggle. */}
          <span className="block text-console-13 text-text-tertiary">
            Read from <span title={settings.declaration?.path}>the pack&apos;s declaration</span>{' '}
            and this project&apos;s <span className="font-mono">{settings.settingsFile}</span>
          </span>
        </>
      }
      chips={chips}
    />
  );
}
