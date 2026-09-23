import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { authStatusQuery } from '@/lib/auth-status';
import { useSession } from '@/lib/auth-client';

/**
 * Gates the app behind a Better Auth session — but ONLY when the server has web
 * auth enabled. When disabled (the default / solo installs), it renders a brief
 * full-screen loader until GET /api/auth/status resolves (cached for the
 * session), then passes children through unchanged.
 *
 * Enabled + no session → redirect to /login. Enabled + session → render the app.
 */
export function SessionGate({ children }: { children: ReactNode }): React.ReactElement {
  const location = useLocation();
  const { data: status, isPending: statusPending, error, refetch } = useQuery(authStatusQuery);
  const { data: session, isPending: sessionPending } = useSession();

  // While we don't yet know whether auth is on, avoid flashing protected
  // content. (status resolves fast and is cached for the session.)
  if (statusPending) {
    return <FullScreenLoader />;
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <p>Could not check authentication. Try again when the server is reachable.</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded border border-border px-4 py-2"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!status.enabled) {
    return <>{children}</>;
  }

  // Auth enabled: wait for the session check, then gate.
  if (sessionPending) {
    return <FullScreenLoader />;
  }
  if (!session?.user) {
    return (
      <Navigate
        to="/login"
        state={{ returnTo: location.pathname + location.search + location.hash }}
        replace
      />
    );
  }
  return <>{children}</>;
}

function FullScreenLoader(): React.ReactElement {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  );
}
