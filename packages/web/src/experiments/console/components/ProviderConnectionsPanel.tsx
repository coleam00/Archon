import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { HttpError } from '../lib/http';
import { SettingsSection } from './SettingsSection';
import { SubscriptionLoginFlow } from './SubscriptionLoginFlow';

// Mirrors AssistantConfigPanel's INPUT_CLASS so inputs match the console form style.
const INPUT_CLASS =
  'w-full rounded-[9px] border border-border bg-surface px-3.5 py-[11px] font-mono text-[13px] text-text-primary placeholder:text-text-tertiary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

/**
 * Per-user AI-provider API keys. Mirrors `GithubIdentityPanel`: reads through
 * the console's react-query-free `useEntity` cache and guards every async
 * setState with a `cancelledRef`.
 *
 * Renders `null` (no panel) when there is nothing to manage: a 401 from
 * `GET /api/auth/providers` (no web identity — solo-PAT or logged-out) or
 * `enabled: false` (no TOKEN_ENCRYPTION_KEY). Any OTHER load error still renders
 * a visible error section rather than hiding it.
 *
 * Both connect paths: an API key for ANY provider (the non-subscription
 * providers — openrouter/openai/codex/Pi backends — are API-key only), plus a
 * subscription "Login" affordance for providers the server advertises in
 * `subscriptionAvailable` (claude/copilot; codex is gated, #1924).
 */
export function ProviderConnectionsPanel(): ReactElement | null {
  const { data, error } = useEntity(K.providerConnections, skill.listProviderKeys);

  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [loginProvider, setLoginProvider] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return (): void => {
      cancelledRef.current = true;
    };
  }, []);

  // Default the provider select to the first available option once loaded.
  useEffect(() => {
    if (data && provider === '' && data.available.length > 0) {
      setProvider(data.available[0] ?? '');
    }
  }, [data, provider]);

  // 401 = no web identity (solo-PAT / logged out): nothing per-user to manage → hide.
  if (error instanceof HttpError && error.status === 401) return null;
  if (error !== undefined) {
    return (
      <SettingsSection title="Provider Auth">
        <p className="font-mono text-[11px] text-error">{error.message}</p>
      </SettingsSection>
    );
  }
  if (data === undefined) {
    return (
      <SettingsSection title="Provider Auth">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }
  // Gate off (no TOKEN_ENCRYPTION_KEY): per-user keys unavailable → hide.
  if (!data.enabled) return null;

  const save = async (): Promise<void> => {
    if (provider === '' || apiKey.trim() === '') {
      setMessage('Choose a provider and paste a key.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await skill.setProviderKey(provider, apiKey.trim(), label.trim() || undefined);
      if (cancelledRef.current) return;
      setApiKey('');
      setLabel('');
      invalidate(K.providerConnections);
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setMessage(e instanceof Error ? e.message : 'Failed to save key.');
    } finally {
      if (!cancelledRef.current) setSaving(false);
    }
  };

  const disconnect = async (p: string): Promise<void> => {
    setDisconnecting(p);
    setMessage(null);
    try {
      await skill.deleteProviderKey(p);
      if (cancelledRef.current) return;
      invalidate(K.providerConnections);
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setMessage(e instanceof Error ? e.message : 'Disconnect failed.');
    } finally {
      if (!cancelledRef.current) setDisconnecting(null);
    }
  };

  return (
    <SettingsSection title="Provider Auth">
      <div className="flex flex-col gap-4 text-[12px]">
        <p className="text-text-secondary">
          Connect your own provider API keys. Runs and chats you start bill to your key instead of
          the shared install key.
        </p>

        {data.connections.length > 0 ? (
          <div className="flex flex-col gap-2">
            {data.connections.map(c => (
              <div
                key={c.provider}
                className="flex items-center justify-between gap-3 rounded border border-border bg-surface-inset px-3 py-2"
              >
                <span className="text-text-secondary">
                  <span className="font-medium text-text-primary">{c.provider}</span>
                  <span className="ml-2 text-text-tertiary">
                    {c.kind}
                    {c.label ? ` · ${c.label}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void disconnect(c.provider)}
                  disabled={disconnecting === c.provider}
                  className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40"
                >
                  {disconnecting === c.provider ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-text-tertiary">No provider keys connected yet.</p>
        )}

        {data.subscriptionAvailable.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-text-secondary">
              Or connect a subscription — bills to your plan, no API key needed:
            </p>
            {data.subscriptionAvailable.map(p => {
              const connected = data.connections.some(c => c.provider === p && c.kind === 'oauth');
              if (loginProvider === p) {
                return (
                  <SubscriptionLoginFlow
                    key={p}
                    provider={p}
                    onDone={() => {
                      setLoginProvider(null);
                    }}
                  />
                );
              }
              return (
                <div
                  key={p}
                  className="flex items-center justify-between gap-3 rounded border border-border bg-surface-inset px-3 py-2"
                >
                  <span className="text-text-secondary">
                    <span className="font-medium capitalize text-text-primary">{p}</span>
                    {connected ? (
                      <span className="ml-2 text-text-tertiary">· subscription connected</span>
                    ) : null}
                  </span>
                  {!connected ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLoginProvider(p);
                      }}
                      disabled={loginProvider !== null}
                      className="brand-bar shrink-0 rounded px-3 py-0.5 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                    >
                      Login
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5 border-t border-border pt-3">
          <div className="flex gap-2">
            <select
              value={provider}
              onChange={e => {
                setProvider(e.target.value);
              }}
              aria-label="Provider"
              className={`${INPUT_CLASS} max-w-[180px]`}
            >
              {data.available.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={label}
              onChange={e => {
                setLabel(e.target.value);
              }}
              placeholder="Label (optional)"
              className={INPUT_CLASS}
            />
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={e => {
              setApiKey(e.target.value);
            }}
            placeholder="Paste API key"
            autoComplete="off"
            className={INPUT_CLASS}
          />
          <div className="flex items-center justify-between gap-3">
            {message !== null ? (
              <p className="font-mono text-[11px] text-error">{message}</p>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || provider === '' || apiKey.trim() === ''}
              className="brand-bar shrink-0 rounded px-3 py-1 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
