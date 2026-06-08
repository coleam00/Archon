import { type ReactElement } from 'react';
import { AssistantConfigPanel } from '../components/AssistantConfigPanel';
import { SystemPanel } from '../components/SystemPanel';
import { GithubIdentityPanel } from '../components/GithubIdentityPanel';

/**
 * Global (installation-wide) console settings — assistant config + system health.
 * Mounted at `/console/settings`, not under a project, because the write path
 * (PATCH /api/config/assistants → ~/.archon/config.yaml) is global only.
 */
export function SettingsPage(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-10 pt-[22px]">
        <h1 className="text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        <div className="mx-auto flex max-w-[680px] flex-col gap-[22px]">
          <AssistantConfigPanel />
          <SystemPanel />
          <GithubIdentityPanel />
        </div>
      </div>
    </div>
  );
}
