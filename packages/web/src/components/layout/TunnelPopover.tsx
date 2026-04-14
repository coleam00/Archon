import { createElement, useState, useEffect } from 'react';
import { Share2, Copy, Check, Loader2, Wifi, WifiOff, ChevronDown, ChevronUp } from 'lucide-react';

type TunnelStatus = 'inactive' | 'starting' | 'active' | 'error';

interface TunnelState {
  status: TunnelStatus;
  url: string | null;
}

/**
 * Cloudflare Quick Tunnel popover.
 * Returns null when the app is already accessed via a Cloudflare tunnel URL
 * (no point tunnelling an already-tunnelled session).
 */
export function TunnelPopover(): React.ReactElement | null {
  // Hide the button if the app is already accessed through a Cloudflare tunnel
  const isAlreadyTunneled =
    window.location.hostname.includes('trycloudflare.com') ||
    window.location.hostname.includes('cloudflareaccess.com');

  if (isAlreadyTunneled) return null;

  return <TunnelPopoverInner />;
}

function TunnelPopoverInner(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelState>({ status: 'inactive', url: null });
  const [copied, setCopied] = useState(false);

  // Poll status every 2 s while the popover is open or the tunnel is starting
  useEffect(() => {
    const shouldPoll = open || tunnel.status === 'starting';
    if (!shouldPoll) return;

    const interval = setInterval(async () => {
      const res = await fetch('/api/tunnel');
      if (res.ok) {
        const data = (await res.json()) as TunnelState;
        setTunnel(data);
      }
    }, 2000);

    return (): void => {
      clearInterval(interval);
    };
  }, [open, tunnel.status]);

  const handleStart = async (): Promise<void> => {
    setTunnel(t => ({ ...t, status: 'starting' }));
    await fetch('/api/tunnel/start', { method: 'POST' });
  };

  const handleStop = async (): Promise<void> => {
    await fetch('/api/tunnel/stop', { method: 'DELETE' });
    setTunnel({ status: 'inactive', url: null });
  };

  const handleCopy = async (): Promise<void> => {
    if (tunnel.url) {
      await navigator.clipboard.writeText(tunnel.url);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    }
  };

  // Icon in the TopNav changes with tunnel status
  const navIcon =
    tunnel.status === 'active' ? Wifi : tunnel.status === 'starting' ? Loader2 : WifiOff;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(o => !o);
        }}
        className={`p-2 rounded-md hover:bg-surface-elevated transition-colors relative text-text-secondary hover:text-text-primary ${
          tunnel.status === 'active' ? 'text-green-500 hover:text-green-400' : ''
        }`}
        aria-label="Cloudflare tunnel"
        title="Cloudflare tunnel"
      >
        {createElement(navIcon, {
          className: `h-5 w-5 ${tunnel.status === 'starting' ? 'animate-spin' : ''}`,
        })}
        {tunnel.status === 'active' && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-green-500" />
        )}
      </button>

      {open && (
        <>
          {/* Backdrop to close on outside click */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setOpen(false);
            }}
          />

          {/* Popover panel */}
          <div className="absolute right-0 top-full mt-2 w-72 z-50 rounded-lg border border-border bg-surface shadow-lg p-4 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Share2 className="h-4 w-4 text-text-secondary" />
                <p className="font-medium text-sm text-text-primary">Cloudflare Tunnel</p>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  tunnel.status === 'active'
                    ? 'bg-green-500/20 text-green-500'
                    : tunnel.status === 'starting'
                      ? 'bg-yellow-500/20 text-yellow-500'
                      : 'bg-surface-elevated text-text-secondary'
                }`}
              >
                {tunnel.status === 'active'
                  ? 'Active'
                  : tunnel.status === 'starting'
                    ? 'Starting...'
                    : tunnel.status === 'error'
                      ? 'Error'
                      : 'Inactive'}
              </span>
            </div>

            {/* Public URL display */}
            {tunnel.url && (
              <div className="flex items-center gap-2 bg-surface-elevated rounded-md px-3 py-2">
                <span className="text-xs truncate flex-1 font-mono text-text-primary">
                  {tunnel.url}
                </span>
                <button
                  onClick={() => void handleCopy()}
                  className="shrink-0 text-text-secondary hover:text-text-primary transition-colors"
                  title="Copy URL"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            )}

            {/* Action button */}
            {tunnel.status === 'inactive' || tunnel.status === 'error' ? (
              <button
                onClick={() => void handleStart()}
                className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Start tunnel
              </button>
            ) : tunnel.status === 'active' ? (
              <button
                onClick={() => void handleStop()}
                className="w-full py-2 px-4 rounded-md border border-border text-sm font-medium hover:bg-surface-elevated transition-colors text-text-primary"
              >
                Stop tunnel
              </button>
            ) : (
              <div className="text-center text-sm text-text-secondary py-1">
                Connecting to Cloudflare...
              </div>
            )}

            <p className="text-xs text-text-secondary">
              URL changes on every restart. Requires{' '}
              <code className="font-mono text-xs">cloudflared</code> installed.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Inline tunnel controls for use inside a dropdown menu (mobile).
 * Expands in-place instead of opening a floating popover.
 */
export function TunnelMenuItem(): React.ReactElement | null {
  const isAlreadyTunneled =
    window.location.hostname.includes('trycloudflare.com') ||
    window.location.hostname.includes('cloudflareaccess.com');

  if (isAlreadyTunneled) return null;

  return <TunnelMenuItemInner />;
}

function TunnelMenuItemInner(): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelState>({ status: 'inactive', url: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const shouldPoll = expanded || tunnel.status === 'starting';
    if (!shouldPoll) return;
    const interval = setInterval(async () => {
      const res = await fetch('/api/tunnel');
      if (res.ok) {
        const data = (await res.json()) as TunnelState;
        setTunnel(data);
      }
    }, 2000);
    return (): void => {
      clearInterval(interval);
    };
  }, [expanded, tunnel.status]);

  const handleStart = async (): Promise<void> => {
    setTunnel(t => ({ ...t, status: 'starting' }));
    await fetch('/api/tunnel/start', { method: 'POST' });
  };

  const handleStop = async (): Promise<void> => {
    await fetch('/api/tunnel/stop', { method: 'DELETE' });
    setTunnel({ status: 'inactive', url: null });
  };

  const handleCopy = async (): Promise<void> => {
    if (tunnel.url) {
      await navigator.clipboard.writeText(tunnel.url);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    }
  };

  const statusIcon =
    tunnel.status === 'active' ? Wifi : tunnel.status === 'starting' ? Loader2 : WifiOff;

  return (
    <div className="border-t border-border mt-1 pt-1">
      {/* Row toggle */}
      <button
        onClick={() => {
          setExpanded(e => !e);
        }}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-elevated transition-colors"
      >
        {createElement(statusIcon, {
          className: `h-4 w-4 shrink-0 ${tunnel.status === 'starting' ? 'animate-spin' : ''} ${tunnel.status === 'active' ? 'text-green-500' : ''}`,
        })}
        <span className="flex-1 text-left">Cloudflare Tunnel</span>
        {tunnel.status === 'active' && <span className="text-xs text-green-500 mr-1">Active</span>}
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
      </button>

      {/* Inline expanded panel */}
      {expanded && (
        <div className="mx-3 mb-2 space-y-2">
          {tunnel.url && (
            <div className="flex items-center gap-2 bg-surface-elevated rounded-md px-3 py-2">
              <span className="text-xs truncate flex-1 font-mono text-text-primary">
                {tunnel.url}
              </span>
              <button
                onClick={() => void handleCopy()}
                className="shrink-0 text-text-secondary hover:text-text-primary transition-colors"
                title="Copy URL"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          )}
          {tunnel.status === 'inactive' || tunnel.status === 'error' ? (
            <button
              onClick={() => void handleStart()}
              className="w-full py-1.5 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Start tunnel
            </button>
          ) : tunnel.status === 'active' ? (
            <button
              onClick={() => void handleStop()}
              className="w-full py-1.5 px-3 rounded-md border border-border text-xs font-medium hover:bg-surface-elevated transition-colors text-text-primary"
            >
              Stop tunnel
            </button>
          ) : (
            <p className="text-xs text-center text-text-secondary py-1">Connecting...</p>
          )}
          <p className="text-xs text-text-secondary">
            Requires <code className="font-mono">cloudflared</code> installed.
          </p>
        </div>
      )}
    </div>
  );
}
