import { queryOptions } from '@tanstack/react-query';
import type { components } from './api.generated';

export async function getAuthStatus(): Promise<components['schemas']['AuthStatusResponse']> {
  const response = await fetch('/api/auth/status');
  if (!response.ok) {
    throw new Error(`Could not check authentication (HTTP ${String(response.status)}).`);
  }
  return response.json() as Promise<components['schemas']['AuthStatusResponse']>;
}

export const authStatusQuery = queryOptions({
  queryKey: ['auth-status'],
  queryFn: getAuthStatus,
  staleTime: 5 * 60 * 1000,
});
