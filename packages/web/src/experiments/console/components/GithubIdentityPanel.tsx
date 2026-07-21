import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { HttpError } from '../lib/http';
import { SettingsSection } from './SettingsSection';

type Phase = 'idle' | 'pending' | 'error';

/**
 * Per-user GitHub identity, via the device flow. `GET /api/auth/github` 401s when
 * there's no web identity (the solo-PAT state, and also a logged-out user on a
 * web-auth install); we render NOTHING then so there's no irrelevant panel. Any
 * other error surfaces normally.
 *
 * The connect flow ports the old UI's polling state machine into the console's
 * react-query-free cache: start → poll every `interval`s until connected / expired
 * / denied. A `cancelledRef` (set on unmount) stops the loop and guards every
 * setState so a long poll can't write after unmount.
 */
export function GithubIdentityPanel(): ReactElement | null {
  const { data: status, error } = useEntity(K.githubConnection, skill.getGithubConnection);

  const [phase, setPhase] = useState<Phase>('idle');
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return (): void => {
      cancelledRef.current = true;
    };
  }, []);

  const connect = async (): Promise<void> => {
    setPhase('pending');
    setMessage(null);
    try {
      const start = await skill.startGithubDeviceFlow();
      if (cancelledRef.current) return;
      setUserCode(start.user_code);
      setVerificationUri(start.verification_uri);
      const deadline = Date.now() + start.expires_in * 1000;
      let interval = Math.max(1, start.interval);
      for (;;) {
        if (cancelledRef.current) return;
        if (Date.now() > deadline) throw new Error('Device code expired — try again.');
        await new Promise(r => setTimeout(r, interval * 1000));
        if (cancelledRef.current) return;
        const res = await skill.pollGithubDeviceFlow(start.device_code);
        const step = skill.interpretPollStatus(res, interval);
        if (step.kind === 'connected') {
          // Keep `phase = 'pending'` (button stays "Connecting…") until the
          // invalidate refetch flips `status.connected` to true — otherwise the
          // not-connected branch flashes "Connect GitHub" for one render.
          setUserCode(null);
          setVerificationUri(null);
          invalidate(K.githubConnection);
          return;
        }
        if (step.kind === 'retry') {
          interval = step.nextInterval;
          continue;
        }
        throw new Error(step.message); // 'failed'
      }
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setPhase('error');
      setUserCode(null);
      setVerificationUri(null);
      setMessage(e instanceof Error ? e.message : 'GitHub connect failed.');
    }
  };

  const disconnect = async (): Promise<void> => {
    setDisconnecting(true);
    setMessage(null);
    setPhase('idle'); // clear any leftover 'pending' from a prior connect
    try {
      await skill.disconnectGithub();
      if (cancelledRef.current) return;
      invalidate(K.githubConnection);
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setMessage(e instanceof Error ? e.message : 'Disconnect failed.');
    } finally {
      if (!cancelledRef.current) setDisconnecting(false);
    }
  };

  // 401 = no web identity (no Better Auth session and no X-Archon-User): the solo-PAT
  // state, and also a logged-out user on a web-auth install. Either way there's no
  // per-user GitHub identity to manage, so hide the panel rather than error.
  if (error instanceof HttpError && error.status === 401) return null;
  if (error !== undefined) {
    return (
      <SettingsSection title="GitHub Identity">
        <p className="font-mono text-[11px] text-error">{error.message}</p>
      </SettingsSection>
    );
  }
  if (status === undefined) {
    return (
      <SettingsSection title="GitHub Identity">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="GitHub Identity">
      <div className="flex flex-col gap-3 text-[12px]">
        {status.connected ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-secondary">
              Connected as{' '}
              <span className="font-medium text-text-primary">@{status.githubLogin}</span>
            </span>
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={disconnecting}
              className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-secondary">
              Connect your GitHub account so PR comments and commits attribute to you.
            </span>
            <button
              type="button"
              onClick={() => void connect()}
              disabled={phase === 'pending'}
              className="brand-bar shrink-0 rounded px-3 py-0.5 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {phase === 'pending' ? 'Connecting…' : 'Connect GitHub'}
            </button>
          </div>
        )}

        {phase === 'pending' && userCode !== null && verificationUri !== null ? (
          <div className="rounded border border-border bg-surface-inset p-3 text-text-secondary">
            Visit{' '}
            <a
              href={verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-primary underline underline-offset-2"
            >
              {verificationUri}
            </a>{' '}
            and enter code:{' '}
            <span className="font-mono font-semibold tracking-widest text-text-primary">
              {userCode}
            </span>
            <span className="ml-2 text-text-tertiary">(polling…)</span>
          </div>
        ) : null}

        {/* `message` is only ever set by a failed connect OR disconnect (both clear
            it on start), so render it whenever present — gating on `phase === 'error'`
            silently swallowed disconnect failures. */}
        {message !== null ? <p className="font-mono text-[11px] text-error">{message}</p> : null}
      </div>
    </SettingsSection>
  );
}
