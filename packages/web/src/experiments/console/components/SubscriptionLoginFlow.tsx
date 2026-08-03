import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { ProviderOAuthStart } from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import { normalizeOAuthCode } from '../lib/oauth-code';
import { mergeOAuthSignals } from '../lib/oauth-flow';
import { useCancelledRef } from '../lib/use-cancelled-ref';

type Phase = 'starting' | 'manual' | 'device' | 'error';

/**
 * Drives one subscription (OAuth) login for `provider` through the held-session
 * bridge. Mirrors GithubIdentityPanel's poll loop, generalized to both bridge
 * modes: `device` (copilot — show user-code + URL, poll) and `manual` (claude —
 * show URL + a paste-code input; the single poll loop submits the pasted code via
 * `pendingCodeRef`, and also catches the local-callback-server resolution with no
 * paste). On `connected` it invalidates the connections cache and calls `onDone`.
 */
export function SubscriptionLoginFlow({
  provider,
  displayName,
  onDone,
}: {
  provider: string;
  /** Human label for the heading; falls back to the raw provider id. */
  displayName?: string;
  onDone: () => void;
}): ReactElement {
  const [phase, setPhase] = useState<Phase>('starting');
  const [start, setStart] = useState<ProviderOAuthStart | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  // Unmount guard. The hook's ref is mount-scoped, so a `provider` change
  // would NOT flip it — the effect below adds a per-run `superseded` flag for
  // that case (old poll loop must stop when a new provider's flow starts).
  const cancelledRef = useCancelledRef();
  const pendingCodeRef = useRef<string | undefined>(undefined);
  // Keep `onDone` in a ref so the start/poll effect depends only on `provider`.
  // Otherwise the parent's inline `onDone={() => …}` is a fresh fn each render,
  // and a mid-flow parent re-render would tear down the effect and RESTART the
  // OAuth session (dropping the in-flight login + any pasted code). (#1926 I1)
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    // `superseded` covers the provider-change case (effect cleanup re-runs but
    // the component stays mounted); `cancelledRef` covers unmount.
    let superseded = false;
    const stale = (): boolean => superseded || cancelledRef.current;
    let started = false;

    const pollLoop = async (sessionId: string): Promise<void> => {
      const deadline = Date.now() + 10 * 60 * 1000; // bridge SESSION_TTL_MS
      for (;;) {
        if (stale()) return;
        if (Date.now() > deadline) {
          setPhase('error');
          setMessage('Login timed out — close and try again.');
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
        if (stale()) return;
        try {
          const submit = pendingCodeRef.current;
          pendingCodeRef.current = undefined;
          const res = await skill.pollProviderOAuth(provider, sessionId, submit);
          if (stale()) return;
          // The authorize URL / device code can arrive via POLL rather than
          // start (supersede latency) — merge late signals or the manual
          // panel stays linkless forever while polling "pending".
          setStart(prev => (prev ? mergeOAuthSignals(prev, res) : prev));
          const polledMode = res.mode;
          if (polledMode) {
            setPhase(p => (p === 'error' ? p : polledMode));
          }
          if (res.status === 'connected') {
            invalidate(K.providerConnections);
            onDoneRef.current();
            return;
          }
          if (res.status === 'error') {
            setPhase('error');
            setMessage(res.detail ?? 'Login failed.');
            return;
          }
          // 'pending' → keep polling
        } catch (e: unknown) {
          if (stale()) return;
          setPhase('error');
          setMessage(e instanceof Error ? e.message : 'Login poll failed.');
          return;
        }
      }
    };

    void (async (): Promise<void> => {
      try {
        const s = await skill.startProviderOAuth(provider);
        if (stale() || started) return;
        started = true;
        setStart(s);
        setPhase(s.mode === 'device' ? 'device' : 'manual');
        void pollLoop(s.sessionId);
      } catch (e: unknown) {
        if (stale()) return;
        setPhase('error');
        setMessage(e instanceof Error ? e.message : 'Failed to start login.');
      }
    })();

    return (): void => {
      superseded = true;
    };
  }, [provider, cancelledRef]);

  const submitCode = (): void => {
    if (code.trim() === '') return;
    pendingCodeRef.current = normalizeOAuthCode(code);
    setCode('');
    setMessage('Submitting…');
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-surface-inset p-3 text-[12px] text-text-secondary">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-text-primary capitalize">
          {displayName ?? provider} subscription login
        </span>
        <button
          type="button"
          onClick={onDone}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          Cancel
        </button>
      </div>

      {phase === 'starting' ? <span className="text-text-tertiary">Starting…</span> : null}

      {phase === 'device' && start?.userCode && start.verificationUri ? (
        <span>
          Visit{' '}
          <a
            href={start.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-primary underline underline-offset-2"
          >
            {start.verificationUri}
          </a>{' '}
          and enter code:{' '}
          <span className="font-mono font-semibold tracking-widest text-text-primary">
            {start.userCode}
          </span>
          <span className="ml-2 text-text-tertiary">(polling…)</span>
        </span>
      ) : null}

      {phase === 'manual' && !start?.url ? (
        <span className="text-text-tertiary">
          Waiting for the authorization link… (the provider flow is starting; this can take a few
          seconds when a previous attempt was just cancelled)
        </span>
      ) : null}

      {phase === 'manual' && start?.url ? (
        <div className="flex flex-col gap-2">
          <span>
            1. Open{' '}
            <a
              href={start.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-primary underline underline-offset-2"
            >
              this authorization link
            </a>{' '}
            and approve.
          </span>
          <span className="text-text-tertiary">
            2. If it shows a code (or a failed <code className="font-mono">localhost</code>{' '}
            redirect), paste the code or the whole redirect URL below. (If you’re on the same
            machine as the server, it may connect on its own.)
          </span>
          <div className="flex gap-2">
            <input
              type="text"
              value={code}
              onChange={e => {
                setCode(e.target.value);
              }}
              placeholder="Paste code or localhost callback URL"
              autoComplete="off"
              className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-accent-bright/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={submitCode}
              disabled={code.trim() === ''}
              className="brand-bar shrink-0 rounded px-3 py-1 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              Submit
            </button>
          </div>
        </div>
      ) : null}

      {message !== null ? (
        <p
          className={`font-mono text-[11px] ${phase === 'error' ? 'text-error' : 'text-text-tertiary'}`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
