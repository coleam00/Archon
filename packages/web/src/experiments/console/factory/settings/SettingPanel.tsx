import type { ReactElement } from 'react';
import type { FactoryPackSettings } from '../../skills/factory';
import { ClampedSummary } from '../ClampedSummary';
import { IdTag, Panel, type ToneColor } from '../document';
import { ShadowBadge } from '../ShadowBadge';
import { settingLabel } from '../lib/setting-name';
import { SettingValue } from './SettingValue';

type Setting = FactoryPackSettings['settings'][number];
type ProjectSettings = FactoryPackSettings['projects'][number];

/**
 * One setting as a compact panel (owner change 6 of 2026-11-21): its plain name with the id
 * beside it, one line of what it does, what the project in focus sets as the most prominent
 * thing, and the pack's declared default as meta when it has one. Its bar is the section's colour, or `--node-opaque` on
 * a shadow (Visual standard, rule 10), which also says what would change once it is live.
 */
export function SettingPanel({
  setting,
  project,
  tone,
}: {
  setting: Setting;
  project: ProjectSettings | undefined;
  tone: ToneColor;
}): ReactElement {
  return (
    <Panel
      as="li"
      data-setting={setting.name}
      tone={setting.shadow ? 'var(--node-opaque)' : tone}
      bar="left"
      className="flex flex-col gap-3 py-4 pr-4 pl-5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-console-15 font-semibold text-text-primary">
          {settingLabel(setting.name)}
        </h3>
        <IdTag id={setting.name} />
        {setting.shadow ? <ShadowBadge className="ml-auto" /> : null}
      </div>
      {setting.description === null ? null : (
        <ClampedSummary text={setting.description} lines={1} />
      )}
      <div data-setting-value="">
        <SettingValue setting={setting} project={project} />
      </div>
      {setting.shadow && setting.whenLive !== null ? (
        <p className="text-console-13 text-text-tertiary">{setting.whenLive}</p>
      ) : null}
      {/* An empty declared default is the pack's own policy or none; the pill already says the
          pack applies, so only a real value is worth a line. */}
      {project === undefined || setting.default === null || setting.default === '' ? null : (
        <p className="text-console-12 text-text-tertiary [overflow-wrap:anywhere]">
          Pack default: <span className="font-mono">{setting.default}</span>
        </p>
      )}
    </Panel>
  );
}
