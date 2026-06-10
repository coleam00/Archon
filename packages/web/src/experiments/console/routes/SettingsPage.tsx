import { type ReactElement } from 'react';
import { ModelTiersPanel } from '../components/ModelTiersPanel';
import { ProviderConnectionsPanel } from '../components/ProviderConnectionsPanel';
import { AssistantConfigPanel } from '../components/AssistantConfigPanel';
import { SystemPanel } from '../components/SystemPanel';
import { GithubIdentityPanel } from '../components/GithubIdentityPanel';

/**
 * Global (installation-wide) console "AI Settings" — sectioned: Model Tiers (the
 * config tiers editor, ungated) → Provider Auth (per-user keys + subscription
 * login) → Defaults (default assistant + per-provider model) → System → GitHub.
 * Mounted at `/console/settings`; the config write paths (PATCH /api/config/*
 * → ~/.archon/config.yaml) are install-wide.
 */
export function SettingsPage(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-10 pt-[22px]">
        <h1 className="text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        <div className="mx-auto flex max-w-[680px] flex-col gap-[22px]">
          <ModelTiersPanel />
          <ProviderConnectionsPanel />
          <AssistantConfigPanel />
          <SystemPanel />
          <GithubIdentityPanel />
        </div>
      </div>
    </div>
  );
}
