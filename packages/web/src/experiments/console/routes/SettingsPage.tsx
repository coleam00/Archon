import { type ReactElement } from 'react';
import { ModelTiersPanel } from '../components/ModelTiersPanel';
import { AliasesPanel } from '../components/AliasesPanel';
import { AgentsPanel } from '../components/AgentsPanel';
import { AssistantConfigPanel } from '../components/AssistantConfigPanel';
import { SystemPanel } from '../components/SystemPanel';
import { GithubIdentityPanel } from '../components/GithubIdentityPanel';
import { AttentionAlertsPanel } from '../components/AttentionAlertsPanel';

/**
 * Global (installation-wide) console "AI Settings" — sectioned: Model Tiers (the
 * config tiers editor, ungated) → Agents (per-agent credential cards: keys +
 * subscription login, #1956) → Defaults (default assistant + per-provider
 * model) → System → GitHub → Alerts. Mounted at `/console/settings`; the config
 * write paths (PATCH /api/config/* → ~/.archon/config.yaml) are install-wide,
 * except Alerts, which is saved per browser.
 */
export function SettingsPage(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-10 pt-5.5">
        <h1 className="text-console-22 font-extrabold tracking-console-tighter text-text-primary">
          Settings
        </h1>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        <div className="mx-auto flex max-w-170 flex-col gap-5.5">
          <ModelTiersPanel />
          <AliasesPanel />
          <AgentsPanel />
          <AssistantConfigPanel />
          <SystemPanel />
          <GithubIdentityPanel />
          <AttentionAlertsPanel />
        </div>
      </div>
    </div>
  );
}
