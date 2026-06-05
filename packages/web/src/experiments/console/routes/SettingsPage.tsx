import { type ReactElement } from 'react';
import { AssistantConfigPanel } from '../components/AssistantConfigPanel';
import { SystemPanel } from '../components/SystemPanel';

/**
 * Global (installation-wide) console settings — assistant config + system health.
 * Mounted at `/console/settings`, not under a project, because the write path
 * (PATCH /api/config/assistants → ~/.archon/config.yaml) is global only.
 */
export function SettingsPage(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <h1 className="truncate text-base font-medium text-text-primary">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <AssistantConfigPanel />
          <SystemPanel />
        </div>
      </div>
    </div>
  );
}
