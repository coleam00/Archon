import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authStatusQuery } from '@/lib/auth-status';
import { signOut, useSession } from '@/lib/auth-client';

export function SessionMenu(): ReactElement | null {
  const { data: status } = useQuery(authStatusQuery);
  const { data: session } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status?.enabled || !session?.user) return null;

  async function handleSignOut(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await signOut();
      if (result.error) {
        setError(result.error.message ?? 'Could not sign out. Try again.');
        return;
      }
      // A new identity must not inherit the previous console's in-memory cache.
      window.location.assign('/login');
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-t border-border px-3 py-2 text-[12px]">
      <p className="truncate text-text-tertiary" title={session.user.email}>
        {session.user.name || session.user.email}
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => void handleSignOut()}
        className="mt-1 rounded px-2 py-1 text-text-secondary hover:bg-surface-hover disabled:opacity-50"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
