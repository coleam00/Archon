import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { errorDetail } from '../../lib/http';
import type { FactoryPackSettings } from '../../skills/factory';
import { SkeletonBlock, SkeletonGroup, SkeletonInnerLine } from '../../components/Skeleton';
import { Panel } from '../document';
import { FactoryFrame } from '../FactoryFrame';
import { FactoryLoading } from '../FactoryLoading';
import { readFailed } from '../lib/deadline';
import { packDisplayName } from '../lib/pack-name';
import type { FactoryViewListed } from '../lib/views';
import { useFactoryPackSettings } from '../useFactoryPackSettings';
import { SettingsHeader } from './SettingsHeader';
import { NoSettings, ProjectUnreadable, SettingsErrors, Undeclared } from './SettingsNotices';
import { SETTINGS_GRID, SettingsSections } from './SettingsSections';

/**
 * `/console/p/:projectId/factory/settings`: how this project has set up the pack its factory view
 * draws, read-only, as a document page (DESIGN.md, owner changes 5 and 6 of 2026-11-21, moved
 * here by the owner change of 2026-11-23). A header band counts the settings, then each section
 * the overview file's map names holds a panel per setting, with what this project sets.
 * Everything comes from the pack's declaration, the overview's map and the project's file;
 * nothing here names a setting, and no other project that runs the pack is named.
 */
export function ProjectSettingsPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return (
    <FactoryFrame section="settings" wide>
      {view => <ProjectSettings projectId={projectId} view={view} />}
    </FactoryFrame>
  );
}

function ProjectSettings({
  projectId,
  view,
}: {
  projectId: string;
  view: FactoryViewListed;
}): ReactElement {
  const read = useFactoryPackSettings(view.packKey);
  const failed = readFailed(read.error);
  if (read.data !== undefined)
    return (
      <SettingsBody
        projectId={projectId}
        settings={read.data}
        packName={packDisplayName(view.pack)}
      />
    );
  if (failed !== undefined)
    return (
      <Panel role="alert" tone="var(--error)" bar="top" className="px-5 pt-5 pb-4">
        <p className="text-console-14 text-error">
          The pack&apos;s settings could not be read: {errorDetail(failed)}
        </p>
      </Panel>
    );
  return <SettingsSkeleton read={read} />;
}

function SettingsBody({
  projectId,
  settings,
  packName,
}: {
  projectId: string;
  settings: FactoryPackSettings;
  packName: string;
}): ReactElement {
  // The route's project is the codebase the settings read names each project by.
  const project = settings.projects.find(candidate => candidate.codebaseId === projectId);
  return (
    <div data-doc-page="" className="flex flex-col gap-6">
      <SettingsHeader settings={settings} packName={packName} project={project} />
      {project === undefined ? <ProjectNotRead /> : <ProjectUnreadable project={project} />}
      <SettingsErrors settings={settings} />
      <SettingsSections settings={settings} project={project} />
      {project === undefined ? null : <Undeclared project={project} />}
      {settings.settings.length === 0 && !settings.declaration?.error ? <NoSettings /> : null}
    </div>
  );
}

/**
 * The settings read lists no entry for this project (the server reads only a project with a
 * checkout): the page shows the pack's defaults and says so, rather than reading as unset.
 */
function ProjectNotRead(): ReactElement {
  return (
    <Panel role="alert" tone="var(--error)" bar="top" className="px-5 pt-5 pb-4">
      <p className="text-console-14 text-error">
        This project&apos;s settings were not read; the page shows the pack&apos;s defaults.
      </p>
    </Panel>
  );
}

/** Rule 6: the band's and four setting panels' shapes, two across, while the settings are read. */
function SettingsSkeleton({
  read,
}: {
  read: ReturnType<typeof useFactoryPackSettings>;
}): ReactElement {
  return (
    <FactoryLoading read={read}>
      <SkeletonGroup label="Reading the pack's settings" className="flex flex-col gap-6">
        <SkeletonBlock height="h-32">
          <SkeletonInnerLine width="short" />
          <SkeletonInnerLine />
        </SkeletonBlock>
        <div className={SETTINGS_GRID}>
          {['a', 'b', 'c', 'd'].map(key => (
            <SkeletonBlock key={key} height="h-40">
              <SkeletonInnerLine width="short" />
              <SkeletonInnerLine />
              <SkeletonInnerLine width="short" />
            </SkeletonBlock>
          ))}
        </div>
      </SkeletonGroup>
    </FactoryLoading>
  );
}
