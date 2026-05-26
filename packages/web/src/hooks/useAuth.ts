import { useQuery } from '@tanstack/react-query';
import { getAuthMe, type AuthMeResponse } from '@/lib/api';

/**
 * Fetch the current authenticated user from /api/auth/me.
 *
 * Returns null when OIDC is not configured (single-user mode) or when the
 * session is unauthenticated. A non-null value means the user is signed in.
 */
export function useAuth(): {
  user: AuthMeResponse | null;
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ['auth-me'],
    queryFn: getAuthMe,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return {
    user: data ?? null,
    isLoading,
    isAuthenticated: Boolean(data),
  };
}
