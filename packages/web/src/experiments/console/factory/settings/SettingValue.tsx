import type { ReactElement, ReactNode } from 'react';
import { FileText } from 'lucide-react';
import type { FactoryPackSettings } from '../../skills/factory';
import { DefinitionGrid, Panel } from '../document';

type Setting = FactoryPackSettings['settings'][number];
type ProjectSettings = FactoryPackSettings['projects'][number];
type SetValue = Extract<ProjectSettings['values'][string], { state: 'set' }>;
type SettingFile = NonNullable<SetValue['file']>;

/**
 * What the project in focus sets for one setting, the most prominent thing in its panel
 * (owner change 6 of 2026-11-21): a path with a file icon, a value in mono, or a "Pack default"
 * pill when the project leaves it empty or unset. With no project, the pack's default.
 */
export function SettingValue({
  setting,
  project,
}: {
  setting: Setting;
  project: ProjectSettings | undefined;
}): ReactNode {
  if (project === undefined) return <PackDefault setting={setting} />;
  // The page says why once, under its band (`ProjectUnreadable`); each panel only says so.
  if (project.error !== null) return <p className="text-console-13 text-error">Not read</p>;
  const value = project.values[setting.name];
  // The server gives every declared setting a value; a missing one reads as unset.
  if (value === undefined || value.state !== 'set') return <DefaultPill />;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {value.file === null ? (
        <span className="font-mono [overflow-wrap:anywhere] text-console-14 text-text-primary">
          {value.value}
        </span>
      ) : (
        <FileValue file={value.file} />
      )}
      {value.problem === null ? null : (
        <p className="text-console-13 text-error [overflow-wrap:anywhere]">
          A run refuses this value: {value.problem}
        </p>
      )}
    </div>
  );
}

function DefaultPill(): ReactElement {
  return (
    <span
      data-pack-default=""
      className="inline-flex w-fit rounded-full bg-surface-inset px-2.5 py-0.5 text-console-13 font-medium text-text-secondary"
    >
      Pack default
    </span>
  );
}

/** With no project in focus, the value shown is the pack's own default. */
function PackDefault({ setting }: { setting: Setting }): ReactElement {
  if (setting.default === null || setting.default === '') return <DefaultPill />;
  return (
    <span className="font-mono [overflow-wrap:anywhere] text-console-14 text-text-primary">
      {setting.default}
    </span>
  );
}

/** A policy or checks file: its path (whole on hover), whether it is there, and its checks. */
function FileValue({ file }: { file: SettingFile }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
        <span
          title={file.full}
          className="min-w-0 font-mono [overflow-wrap:anywhere] text-console-14 text-text-primary"
        >
          {file.display}
        </span>
      </div>
      {file.status === 'missing' ? (
        <span className="text-console-13 text-error">file not found</span>
      ) : file.status === 'unreadable' ? (
        <span className="text-console-13 text-error [overflow-wrap:anywhere]">
          could not be read: {file.error}
        </span>
      ) : null}
      {file.checks === null ? null : (
        <Panel inset role="group" aria-label="Checks" className="p-3">
          <DefinitionGrid
            rows={file.checks.map(check => ({
              key: check.name,
              label: <span className="font-mono text-text-secondary">{check.name}</span>,
              value: (
                <span className="font-mono [overflow-wrap:anywhere] text-console-13">
                  {check.run}
                </span>
              ),
            }))}
          />
        </Panel>
      )}
    </div>
  );
}
