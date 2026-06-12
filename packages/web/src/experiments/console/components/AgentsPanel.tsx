import { type ReactElement } from 'react';
import * as skill from '../skills';
import type { PiModelInfo, ProviderKeyList } from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { HttpError } from '../lib/http';
import { modelCountByBackend } from '../lib/agent-status';
import { SettingsSection } from './SettingsSection';
import { AgentCredentialCard } from './AgentCredentialCard';

/**
 * Settings → Agents: one card per agent (the only thing the UI calls
 * "provider"), credentials nested inside (#1956, replacing the flat
 * "Provider Auth" dropdown). Data is the grouped `agents` matrix from
 * GET /api/auth/providers (#1955), shared with the tier/alias readiness hints
 * via the `K.providerConnections` cache key.
 *
 * Renders `null` on a 401 (no web identity — solo-PAT or logged out; the
 * endpoint is requireWebUser-gated, known limitation for now). With per-user
 * keys disabled (`enabled: false`, no TOKEN_ENCRYPTION_KEY) the cards still
 * render as install-level status (install env / ambient detection) — only the
 * connect affordances hide.
 */
export function AgentsPanel(): ReactElement | null {
  const { data, error } = useEntity<ProviderKeyList>(K.providerConnections, skill.listProviderKeys);
  // Pi catalog for backend model counts in the picker. Best-effort: the server
  // returns [] when the catalog can't load, and a fetch error means no counts.
  const { data: piModels } = useEntity<PiModelInfo[]>(K.piModels, skill.listPiModels);

  // 401 = no web identity: nothing per-user to manage and the grouped matrix
  // is unavailable (gated endpoint) → hide, matching the previous panel.
  if (error instanceof HttpError && error.status === 401) return null;
  if (error !== undefined) {
    return (
      <SettingsSection title="Agents">
        <p className="font-mono text-[11px] text-error">{error.message}</p>
      </SettingsSection>
    );
  }
  if (data === undefined) {
    return (
      <SettingsSection title="Agents">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const piModelCounts = modelCountByBackend(piModels);
  // Defensive: a server predating the #1958 grouped API can 200 without
  // `agents`. The skew window is narrow (web dist ships with the server) but
  // the failure mode would be an opaque crash instead of an empty panel (I2).
  const agents = data.agents ?? [];

  return (
    <SettingsSection title="Agents">
      <div className="flex flex-col gap-3 text-[12px]">
        <p className="text-text-secondary">
          Each agent lists the credentials it can spend. Connect a key or subscription inside the
          agent you want to run — runs and chats you start bill to your credential instead of the
          shared install key.
        </p>
        {!data.enabled ? (
          <p className="font-mono text-[11px] text-text-tertiary">
            Per-user credentials are disabled on this install (no TOKEN_ENCRYPTION_KEY) — showing
            install-level status only.
          </p>
        ) : null}
        {agents.length === 0 ? (
          <p className="text-text-tertiary">No agents registered.</p>
        ) : (
          agents.map(agent => (
            <AgentCredentialCard
              key={agent.id}
              agent={agent}
              connections={data.connections}
              connectEnabled={data.enabled}
              piModelCounts={piModelCounts}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}
