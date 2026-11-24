/**
 * A pack's settings on one project: every setting the pack declares, with its description,
 * its default and the value this project sets. Read-only: the values live in a file in the
 * project's repository.
 *
 * The page is generated from the pack graph read and names no pack or setting. How settings
 * are grouped into sections, and which ones hold a file path, are the pack's to declare; the
 * page takes them as data and shows one flat list without them.
 */
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { getPackGraph, type PackGraph } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

type Setting = PackGraph['settings'][number];

/** A pack-declared section: a heading and the names of the settings under it, in order. */
export interface SettingSection {
  name: string;
  settings: readonly string[];
}

function SettingRow({ setting }: { setting: Setting }): ReactElement {
  const set = setting.value !== null;
  const shown = setting.value ?? setting.default;
  return (
    <li data-setting={setting.name} data-set={set ? '' : undefined} className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-text-primary">{setting.name}</span>
        <span className="text-console-11 text-text-tertiary">
          {set ? 'set by the project' : 'pack default'}
        </span>
      </div>
      {setting.description === null ? null : (
        <p className="mt-1 text-console-12 text-text-secondary">{setting.description}</p>
      )}
      <p
        data-setting-value
        className="mt-1 break-words font-mono text-console-12 text-text-primary"
      >
        {shown === null || shown === '' ? <span className="text-text-tertiary">empty</span> : shown}
      </p>
    </li>
  );
}

/** The settings as a list, under the pack's sections when it declares any. */
export function PackSettings({
  settings,
  sections = [],
}: {
  settings: readonly Setting[];
  sections?: readonly SettingSection[];
}): ReactElement {
  const inSection = new Set(sections.flatMap(section => section.settings));
  const groups = [
    ...sections.map(section => ({
      name: section.name,
      settings: section.settings.flatMap(name => settings.find(s => s.name === name) ?? []),
    })),
    { name: null, settings: settings.filter(setting => !inSection.has(setting.name)) },
  ].filter(group => group.settings.length > 0);
  return (
    <>
      {groups.map(group => (
        <section key={group.name ?? ''} data-setting-section={group.name ?? ''} className="mb-6">
          {group.name === null ? null : (
            <h2 className="text-sm font-medium text-text-primary">{group.name}</h2>
          )}
          <ul className="divide-y divide-border">
            {group.settings.map(setting => (
              <SettingRow key={setting.name} setting={setting} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export function PackSettingsPage(): ReactElement {
  const { projectId = '', pack = '' } = useParams<{ projectId: string; pack: string }>();
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-4 md:px-6">
        <h1 className="truncate text-base font-medium text-text-primary">{pack}: settings</h1>
        <p className="text-xs text-text-tertiary">
          <Link className="underline" to={`/console/p/${encodeURIComponent(projectId)}/board`}>
            Back to the board
          </Link>
          {graph === undefined ? '' : ` · values from ${graph.settingsFile.path}`}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4 md:px-6">
        {error !== undefined ? <p className="text-console-12 text-error">{error.message}</p> : null}
        {graph === undefined && error === undefined ? (
          <p className="text-console-12 text-text-tertiary">Reading the pack…</p>
        ) : null}
        {graph !== undefined && graph.settingsFile.problems.length > 0 ? (
          <ul data-setting-problems className="mb-4 text-console-12 text-error">
            {graph.settingsFile.problems.map(problem => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {graph !== undefined && graph.settings.length === 0 ? (
          <p className="text-console-12 text-text-tertiary">This pack declares no settings.</p>
        ) : null}
        {graph === undefined ? null : <PackSettings settings={graph.settings} />}
      </div>
    </section>
  );
}
