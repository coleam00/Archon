import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getAuthStatus } from '@/lib/api';
import { signIn, signUp, useSession } from '@/lib/auth-client';

type Mode = 'login' | 'signup';

/**
 * Email/password login + signup for opt-in web auth. Signup may be gated by an
 * invite allowlist (the server returns a 403 the form surfaces). Rendered only
 * when auth is enabled; SessionGate routes here when there is no session.
 */
export function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: status } = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    staleTime: 5 * 60 * 1000,
  });

  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (or auth disabled) → bounce to the app. Declarative
  // redirect (not an imperative navigate() in render) so we short-circuit before
  // rendering the form and don't fire a side effect during React's render phase.
  if (session?.user || status?.enabled === false) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result =
        mode === 'login'
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name: name.trim() || email.split('@')[0] });
      if (result.error) {
        setError(result.error.message ?? 'Authentication failed. Please try again.');
        return;
      }
      navigate('/', { replace: true });
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Self-serve signup is off when the server reports `disabled` (no allowlist +
  // no open-signup flag). Hide the signup affordance entirely so we don't invite
  // a registration the server will only 403. Defaults to allowed while status is
  // still loading (it resolves quickly and the gate only renders when auth is on).
  const signupAllowed = status?.signup !== 'disabled';
  const isSignup = mode === 'signup';

  return (
    <div className="flex h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8 shadow-lg">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary">
            <span className="text-sm font-semibold text-primary-foreground">A</span>
          </div>
          <span className="text-base font-semibold text-text-primary">Archon</span>
        </div>

        <h1 className="mb-1 text-lg font-semibold text-text-primary">
          {isSignup ? 'Create your account' : 'Sign in'}
        </h1>
        <p className="mb-6 text-sm text-text-secondary">
          {isSignup
            ? status?.signup === 'allowlist'
              ? 'Signup is invite-only — use an allowlisted email.'
              : 'Create an account to continue.'
            : 'Sign in to your Archon workspace.'}
        </p>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {isSignup && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text-secondary">Name</span>
              <Input
                type="text"
                autoComplete="name"
                value={name}
                onChange={e => {
                  setName(e.target.value);
                }}
                placeholder="Ada Lovelace"
              />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-secondary">Email</span>
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => {
                setEmail(e.target.value);
              }}
              placeholder="you@example.com"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-secondary">Password</span>
            <Input
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              required
              minLength={8}
              value={password}
              onChange={e => {
                setPassword(e.target.value);
              }}
              placeholder="••••••••"
            />
          </label>

          <Button type="submit" disabled={submitting} className="mt-2 w-full">
            {submitting ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        {signupAllowed && (
          <button
            type="button"
            onClick={() => {
              setMode(isSignup ? 'login' : 'signup');
              setError(null);
            }}
            className="mt-4 w-full text-center text-sm text-text-secondary hover:text-text-primary"
          >
            {isSignup ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </button>
        )}
      </div>
    </div>
  );
}
