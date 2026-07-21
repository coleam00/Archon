/**
 * Pure helpers for the per-agent credential cards (Settings → Agents) and the
 * readiness hints in the Model Tiers / Aliases provider dropdowns (#1956).
 *
 * All functions are side-effect free so they stay unit-testable without DOM
 * rendering — the console's testing pattern for panel logic.
 */
import type {
  AgentCredentialStatus,
  AgentCredentials,
  PiModelInfo,
  ProviderKeyConnection,
} from '../skills';

/**
 * A credential counts as "usable" when the calling user connected it, the
 * install env already carries it, or the ambient chain is detected. Matches
 * the per-credential check in the server's `buildAgentCredentialMatrix`
 * (expressed there with falsy coercion rather than `=== true`). Used for the
 * per-row display and backend counts; the boolean ready/not-ready verdict
 * itself comes from the server's `ready` field (see `agentReadiness`).
 */
export function isCredentialUsable(c: AgentCredentialStatus): boolean {
  return c.connected !== null || c.installEnv || c.ambientConfigured === true;
}

export type AgentReadinessState = 'ready' | 'needs-credential' | 'dynamic';

export interface AgentReadiness {
  state: AgentReadinessState;
  /** Short human detail rendered next to the state dot. */
  detail: string;
}

/** Detail string for one usable credential ("Anthropic key", "subscription", …). */
function usableCredentialDetail(c: AgentCredentialStatus): string {
  if (c.connected === 'oauth') return 'subscription connected';
  if (c.connected === 'api_key') return `${c.displayName} key connected`;
  if (c.installEnv) return 'using install env';
  return 'ambient credentials detected';
}

/**
 * Readiness summary for one agent card header. The ready/not-ready verdict is
 * the server's `ready` field (the source of truth — if its computation gains
 * a dimension, the UI follows automatically, I3); the helpers here only
 * derive the human *reason* label from the per-credential state.
 * Multi-credential agents (Pi) summarize as a backend count; single-credential
 * agents name the credential. Dynamic agents (OpenCode) can only be
 * introspected at runtime.
 */
export function agentReadiness(agent: AgentCredentials): AgentReadiness {
  if (agent.catalog === 'dynamic') {
    return { state: 'dynamic', detail: 'catalog loaded on demand' };
  }
  if (!agent.ready) {
    return { state: 'needs-credential', detail: 'needs credential' };
  }
  const usable = agent.credentials.filter(isCredentialUsable);
  if (agent.credentials.length > 1) {
    return {
      state: 'ready',
      detail: `${String(usable.length)} backend${usable.length === 1 ? '' : 's'} connected`,
    };
  }
  const first = usable[0];
  // Drift guard (live, not dead code): the server said ready but the client's
  // per-credential detection found nothing nameable — fall back to a generic
  // label rather than contradicting the server's verdict.
  return { state: 'ready', detail: first ? usableCredentialDetail(first) : 'ready' };
}

/**
 * Suffix for an agent option in the tier/alias provider dropdowns, e.g.
 * " — 2 backends connected" or " — no credential". Empty string when the
 * agents data is unavailable (solo/401), the agent is unknown, the catalog is
 * dynamic (readiness unknowable without runtime introspection), or a
 * single-credential agent is simply ready (no extra signal needed).
 */
export function providerOptionHint(
  agents: AgentCredentials[] | undefined,
  providerId: string
): string {
  const agent = agents?.find(a => a.id === providerId);
  if (!agent || agent.catalog === 'dynamic') return '';
  const readiness = agentReadiness(agent);
  if (readiness.state === 'needs-credential') return ' — no credential';
  return agent.credentials.length > 1 ? ` — ${readiness.detail}` : '';
}

export interface PiCredentialGroups {
  /** Connected or install-env backends — always rendered as rows. */
  active: AgentCredentialStatus[];
  /** Connectable (api_key) backends behind the searchable "Add backend…" picker. */
  addable: AgentCredentialStatus[];
  /** Ambient cloud chains (bedrock/vertex) — status-only rows at the bottom. */
  ambient: AgentCredentialStatus[];
}

/**
 * Split a large static catalog (Pi) into the three display groups. Ambient
 * credentials are status-only per #1956 even when they also accept a key.
 */
export function splitPiCredentials(agent: AgentCredentials): PiCredentialGroups {
  const active: AgentCredentialStatus[] = [];
  const addable: AgentCredentialStatus[] = [];
  const ambient: AgentCredentialStatus[] = [];
  for (const c of agent.credentials) {
    if (c.kinds.includes('ambient')) {
      ambient.push(c);
    } else if (c.connected !== null || c.installEnv) {
      active.push(c);
    } else if (c.kinds.includes('api_key')) {
      addable.push(c);
    }
  }
  return { active, addable, ambient };
}

/** Case-insensitive search over displayName + vendor id for the backend picker. */
export function filterCredentials(
  credentials: AgentCredentialStatus[],
  query: string
): AgentCredentialStatus[] {
  const q = query.trim().toLowerCase();
  if (q === '') return credentials;
  return credentials.filter(
    c => c.displayName.toLowerCase().includes(q) || c.vendor.toLowerCase().includes(q)
  );
}

/** Model count per Pi backend id, from the (best-effort) Pi model catalog. */
export function modelCountByBackend(models: PiModelInfo[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of models ?? []) {
    counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  }
  return counts;
}

/** The user's stored label for a connected vendor, or null. */
export function connectionLabel(
  connections: ProviderKeyConnection[],
  vendor: string
): string | null {
  return connections.find(c => c.provider === vendor)?.label ?? null;
}
