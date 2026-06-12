import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type {
  AgentCredentialStatus,
  AgentCredentials,
  OpencodeCredentialProvider,
  ProviderKeyConnection,
} from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import {
  agentReadiness,
  connectionLabel,
  filterCredentials,
  splitPiCredentials,
  type AgentReadinessState,
} from '../lib/agent-status';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { SubscriptionLoginFlow } from './SubscriptionLoginFlow';

// Mirrors AssistantConfigPanel's INPUT_CLASS so inputs match the console form style.
const INPUT_CLASS =
  'w-full rounded-[9px] border border-border bg-surface px-3.5 py-[11px] font-mono text-[13px] text-text-primary placeholder:text-text-tertiary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';
const GHOST_BUTTON =
  'shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40';
const BRAND_BUTTON =
  'brand-bar shrink-0 rounded px-3 py-1 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40';

const DOT_CLASS: Record<AgentReadinessState, string> = {
  ready: 'bg-success',
  'needs-credential': 'bg-warning',
  dynamic: 'bg-text-tertiary',
};

const READINESS_TEXT: Record<AgentReadinessState, string> = {
  ready: 'text-success',
  'needs-credential': 'text-warning',
  dynamic: 'text-text-tertiary',
};

/** Human description of an ambient chain's source for the status-only rows. */
function ambientSource(vendor: string): string {
  if (vendor === 'amazon-bedrock') return 'AWS env';
  if (vendor === 'google-vertex') return 'gcloud env';
  return 'env';
}

/**
 * One agent card for the Settings → Agents panel (#1956). Renders the agent's
 * credential surface from the grouped GET /api/auth/providers matrix:
 * - static single-credential agents (Claude/Codex/Copilot): all rows inline;
 * - Pi: connected/install-env rows + a searchable "Add backend…" picker over
 *   the rest, ambient chains as status-only rows at the bottom;
 * - dynamic agents (OpenCode): collapsed until an explicit "Load backends"
 *   action hits the heavyweight introspection endpoint.
 *
 * `connectEnabled` is false when per-user keys are unavailable
 * (no TOKEN_ENCRYPTION_KEY) — cards stay visible as status display, but every
 * connect/disconnect/login affordance hides.
 */
export function AgentCredentialCard({
  agent,
  connections,
  connectEnabled,
  piModelCounts,
}: {
  agent: AgentCredentials;
  connections: ProviderKeyConnection[];
  connectEnabled: boolean;
  piModelCounts: Map<string, number>;
}): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  // At most one inline flow open per card: an API-key form or a login flow.
  const [keyVendor, setKeyVendor] = useState<string | null>(null);
  const [loginVendor, setLoginVendor] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  // Guards only the card's own async action (disconnect). KeyConnectForm and
  // OpencodeBackends carry their own refs — their lifetimes are shorter than
  // the card's (they unmount when the inline flow closes).
  const cancelledRef = useCancelledRef();

  const disconnect = async (vendor: string): Promise<void> => {
    setDisconnecting(vendor);
    setMessage(null);
    try {
      await skill.deleteProviderKey(vendor);
      // Invalidation only touches the cache Map (no React state), so it is
      // unmount-safe — never gate it behind the cancelled guard, or a
      // mid-flight unmount leaves stale connection state in the cache (I1).
      invalidate(K.providerConnections);
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setMessage(e instanceof Error ? e.message : 'Disconnect failed.');
    } finally {
      if (!cancelledRef.current) setDisconnecting(null);
    }
  };

  const readiness = agentReadiness(agent);
  const isMultiBackend = agent.catalog === 'static' && agent.credentials.length > 1;
  const groups = isMultiBackend ? splitPiCredentials(agent) : null;
  const inlineRows = groups ? groups.active : agent.credentials;
  // The picker-selected backend (not yet connected) whose key form is open.
  const pickedAddable =
    groups && keyVendor !== null ? groups.addable.find(c => c.vendor === keyVendor) : undefined;

  const row = (cred: AgentCredentialStatus): ReactElement => (
    <CredentialRow
      key={cred.vendor}
      cred={cred}
      label={connectionLabel(connections, cred.vendor)}
      connectEnabled={connectEnabled}
      keyFormOpen={keyVendor === cred.vendor}
      loginOpen={loginVendor === cred.vendor}
      busy={disconnecting === cred.vendor}
      // Model counts come from the Pi catalog — only meaningful on the
      // multi-backend (Pi) card, not for e.g. the Claude card's 'anthropic' row.
      modelCount={isMultiBackend ? piModelCounts.get(cred.vendor) : undefined}
      onOpenKeyForm={() => {
        setKeyVendor(cred.vendor);
        setLoginVendor(null);
      }}
      onCloseKeyForm={() => {
        setKeyVendor(null);
      }}
      onOpenLogin={() => {
        setLoginVendor(cred.vendor);
        setKeyVendor(null);
      }}
      onCloseLogin={() => {
        setLoginVendor(null);
      }}
      onDisconnect={() => void disconnect(cred.vendor)}
    />
  );

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface-elevated p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-bold text-text-primary">{agent.displayName}</span>
          <span className="font-mono text-[10.5px] text-text-tertiary">{agent.id}</span>
        </span>
        <span
          className={`flex items-center gap-1.5 font-mono text-[11px] ${READINESS_TEXT[readiness.state]}`}
        >
          <span
            aria-hidden
            className={`h-[7px] w-[7px] rounded-full ${DOT_CLASS[readiness.state]}`}
          />
          {readiness.detail}
        </span>
      </div>

      {agent.catalog === 'dynamic' ? (
        <OpencodeBackends />
      ) : (
        <>
          {inlineRows.length > 0 ? (
            <div className="flex flex-col gap-2">{inlineRows.map(row)}</div>
          ) : isMultiBackend ? (
            <p className="text-[12px] text-text-tertiary">No backends connected yet.</p>
          ) : null}

          {groups && connectEnabled ? (
            <BackendPicker
              addable={groups.addable}
              modelCounts={piModelCounts}
              onPick={vendor => {
                setKeyVendor(vendor);
                setLoginVendor(null);
              }}
            />
          ) : null}

          {pickedAddable ? row(pickedAddable) : null}

          {groups && groups.ambient.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
              {groups.ambient.map(cred => (
                <div
                  key={cred.vendor}
                  className="flex items-center justify-between gap-3 px-1 text-[11.5px]"
                >
                  <span className="text-text-secondary">
                    {cred.displayName}{' '}
                    <span className="font-mono text-[10px] text-text-tertiary">{cred.vendor}</span>
                  </span>
                  {cred.ambientConfigured === true ? (
                    <span className="font-mono text-[10.5px] text-success">
                      configured via {ambientSource(cred.vendor)}
                    </span>
                  ) : (
                    <span className="font-mono text-[10.5px] text-text-tertiary">not detected</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {message !== null ? <p className="font-mono text-[11px] text-error">{message}</p> : null}
    </div>
  );
}

/**
 * One credential row: display name + muted vendor id, connection/env status,
 * and (when `connectEnabled`) the connect-key / subscription-login /
 * disconnect affordances. The inline key form and login flow render below the
 * row so the row itself stays scannable.
 */
function CredentialRow({
  cred,
  label,
  connectEnabled,
  keyFormOpen,
  loginOpen,
  busy,
  modelCount,
  onOpenKeyForm,
  onCloseKeyForm,
  onOpenLogin,
  onCloseLogin,
  onDisconnect,
}: {
  cred: AgentCredentialStatus;
  label: string | null;
  connectEnabled: boolean;
  keyFormOpen: boolean;
  loginOpen: boolean;
  busy: boolean;
  modelCount: number | undefined;
  onOpenKeyForm: () => void;
  onCloseKeyForm: () => void;
  onOpenLogin: () => void;
  onCloseLogin: () => void;
  onDisconnect: () => void;
}): ReactElement {
  // Deliberate gating asymmetry: key connect derives from the declared
  // `kinds`, but login uses `subscriptionAvailable` — the server-evaluated
  // runtime gate (it can disable a declared 'subscription' kind, as it did
  // for Codex until #1924). Don't "fix" login to follow the `kinds` pattern.
  const canConnectKey = connectEnabled && cred.kinds.includes('api_key') && cred.connected === null;
  const canLogin = connectEnabled && cred.subscriptionAvailable && cred.connected !== 'oauth';
  const canDisconnect = connectEnabled && cred.connected !== null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-surface-inset px-3 py-2 text-[12px]">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-text-primary">{cred.displayName}</span>
          <span className="font-mono text-[10px] text-text-tertiary">{cred.vendor}</span>
          {cred.connected === 'api_key' ? (
            <span className="font-mono text-[10.5px] text-success">
              API key connected{label ? ` · ${label}` : ''}
            </span>
          ) : null}
          {cred.connected === 'oauth' ? (
            <span className="font-mono text-[10.5px] text-success">subscription connected</span>
          ) : null}
          {cred.installEnv ? (
            <span className="rounded-full border border-border px-2 py-px font-mono text-[10px] text-text-tertiary">
              using install env
            </span>
          ) : null}
          {modelCount !== undefined ? (
            <span className="font-mono text-[10px] text-text-tertiary">
              {modelCount} model{modelCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {canLogin ? (
            <button
              type="button"
              onClick={onOpenLogin}
              disabled={loginOpen}
              className={BRAND_BUTTON}
            >
              Login
            </button>
          ) : null}
          {canConnectKey ? (
            <button
              type="button"
              onClick={keyFormOpen ? onCloseKeyForm : onOpenKeyForm}
              className={GHOST_BUTTON}
            >
              {keyFormOpen ? 'Cancel' : 'Connect key'}
            </button>
          ) : null}
          {canDisconnect ? (
            <button type="button" onClick={onDisconnect} disabled={busy} className={GHOST_BUTTON}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : null}
        </span>
      </div>
      {keyFormOpen ? <KeyConnectForm cred={cred} onDone={onCloseKeyForm} /> : null}
      {loginOpen ? (
        <SubscriptionLoginFlow
          provider={cred.vendor}
          displayName={cred.displayName}
          onDone={onCloseLogin}
        />
      ) : null}
    </div>
  );
}

/** Inline API-key connect form for one vendor (PUT /api/auth/providers/:vendor). */
function KeyConnectForm({
  cred,
  onDone,
}: {
  cred: AgentCredentialStatus;
  onDone: () => void;
}): ReactElement {
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelledRef = useCancelledRef();

  const save = async (): Promise<void> => {
    if (apiKey.trim() === '') return;
    setSaving(true);
    setError(null);
    try {
      await skill.setProviderKey(cred.vendor, apiKey.trim(), label.trim() || undefined);
      // Invalidation only touches the cache Map (no React state), so it is
      // unmount-safe — run it BEFORE the cancelled guard, or a mid-save
      // unmount leaves a stored key rendered as "not connected" (I1).
      invalidate(K.providerConnections);
      if (cancelledRef.current) return;
      onDone();
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to save key.');
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-surface-inset p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          value={apiKey}
          onChange={e => {
            setApiKey(e.target.value);
          }}
          placeholder={`Paste ${cred.displayName} API key`}
          autoComplete="off"
          className={INPUT_CLASS}
        />
        <input
          type="text"
          value={label}
          onChange={e => {
            setLabel(e.target.value);
          }}
          placeholder="Label (optional)"
          className={`${INPUT_CLASS} sm:max-w-[160px]`}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        {error !== null ? <p className="font-mono text-[11px] text-error">{error}</p> : <span />}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || apiKey.trim() === ''}
          className={BRAND_BUTTON}
        >
          {saving ? 'Saving…' : 'Connect'}
        </button>
      </div>
    </div>
  );
}

/**
 * Searchable "Add backend…" picker over Pi's not-yet-connected key backends.
 * The result list renders only while a query is typed — the full catalog
 * (30+ vendors) never renders flat (#1956).
 */
function BackendPicker({
  addable,
  modelCounts,
  onPick,
}: {
  addable: AgentCredentialStatus[];
  modelCounts: Map<string, number>;
  onPick: (vendor: string) => void;
}): ReactElement | null {
  const [query, setQuery] = useState('');
  if (addable.length === 0) return null;
  const searching = query.trim() !== '';
  const matches = filterCredentials(addable, query);

  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="text"
        value={query}
        onChange={e => {
          setQuery(e.target.value);
        }}
        placeholder={`Add backend… (search ${String(addable.length)} available)`}
        aria-label="Search backends to connect"
        className={INPUT_CLASS}
      />
      {searching && matches.length > 0 ? (
        <div className="max-h-52 overflow-y-auto rounded border border-border bg-surface-inset">
          {matches.map(c => {
            const count = modelCounts.get(c.vendor);
            return (
              <button
                key={c.vendor}
                type="button"
                onClick={() => {
                  setQuery('');
                  onPick(c.vendor);
                }}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-[12px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="text-text-primary">{c.displayName}</span>
                  <span className="font-mono text-[10px] text-text-tertiary">{c.vendor}</span>
                </span>
                {count !== undefined ? (
                  <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                    {count} model{count === 1 ? '' : 's'}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {searching && matches.length === 0 ? (
        <p className="px-1 font-mono text-[11px] text-text-tertiary">No backend matches.</p>
      ) : null}
    </div>
  );
}

type OpencodePhase = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Booting the embedded OpenCode runtime is the slow path; give it a generous
 * minute before declaring the load hung so the user always gets the Retry
 * escape (I4) instead of a permanent "Loading…".
 */
const OPENCODE_LOAD_TIMEOUT_MS = 60_000;

/**
 * OpenCode's dynamic backend list. The introspection endpoint is heavyweight
 * (it boots the embedded runtime), so nothing loads until the user explicitly
 * asks; any load failure (503 runtime-unavailable, network error, timeout)
 * gets a retry affordance instead of a dead card.
 */
function OpencodeBackends(): ReactElement {
  const [phase, setPhase] = useState<OpencodePhase>('idle');
  const [providers, setProviders] = useState<OpencodeCredentialProvider[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cancelledRef = useCancelledRef();

  const load = async (): Promise<void> => {
    setPhase('loading');
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        skill.listOpencodeCredentials(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out waiting for the OpenCode runtime — retry.'));
          }, OPENCODE_LOAD_TIMEOUT_MS);
        }),
      ]);
      if (cancelledRef.current) return;
      setProviders(result);
      setPhase('loaded');
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load OpenCode backends.');
      setPhase('error');
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <p className="text-text-tertiary">
        Backends and connection state come from the embedded OpenCode runtime. Connections are
        install-wide, not per-user.
      </p>

      {phase === 'idle' ? (
        <button type="button" onClick={() => void load()} className={`${GHOST_BUTTON} self-start`}>
          Load backends
        </button>
      ) : null}

      {phase === 'loading' ? (
        <p className="font-mono text-[11px] text-text-tertiary">
          Loading backends… (starting the OpenCode runtime can take a moment)
        </p>
      ) : null}

      {phase === 'error' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-[11px] text-error">{error}</p>
          <button type="button" onClick={() => void load()} className={GHOST_BUTTON}>
            Retry
          </button>
        </div>
      ) : null}

      {phase === 'loaded' ? (
        <>
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {providers.map(p => (
              <div
                key={p.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded border border-border bg-surface-inset px-3 py-2"
              >
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium text-text-primary">{p.name}</span>
                  <span className="font-mono text-[10px] text-text-tertiary">{p.id}</span>
                  {p.connected ? (
                    <span className="font-mono text-[10.5px] text-success">connected</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-baseline gap-2 font-mono text-[10px] text-text-tertiary">
                  <span>
                    {p.modelCount} model{p.modelCount === 1 ? '' : 's'}
                  </span>
                  {p.authMethods.length > 0 ? (
                    <span>{p.authMethods.map(m => m.label).join(' · ')}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className={`${GHOST_BUTTON} self-start`}
          >
            Refresh
          </button>
        </>
      ) : null}
    </div>
  );
}
