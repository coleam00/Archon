import { useQuery } from '@tanstack/react-query';
import { listProviders, type ProviderInfo } from '@/lib/api';

/**
 * Fetch registered providers from the server.
 * Cached for the session — provider list rarely changes at runtime.
 */
export function useProviders(): {
  providers: ProviderInfo[];
  isLoading: boolean;
  isError: boolean;
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['providers'],
    queryFn: listProviders,
    staleTime: 5 * 60 * 1000, // 5 min — provider list rarely changes
  });

  return {
    providers: data ?? [],
    isLoading,
    isError,
  };
}
