import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAuthStatus } from '@/lib/api';
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
  const { data: status, isPending: statusPending } = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    staleTime: 5 * 60 * 1000,
  });
  const { data: session, isPending: sessionPending } = useSession();

  // While we don't yet know whether auth is on, avoid flashing protected
  // content. (status resolves fast and is cached for the session.)
  if (statusPending) {
    return <FullScreenLoader />;
  }

  // Auth disabled → passthrough (today's behavior, zero change).
  if (!status?.enabled) {
    return <>{children}</>;
  }

  // Auth enabled: wait for the session check, then gate.
  if (sessionPending) {
    return <FullScreenLoader />;
  }
  if (!session?.user) {
    return <Navigate to="/login" replace />;
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
