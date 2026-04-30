import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelSymphony,
  dispatchSymphony,
  getSymphonyState,
  listSymphonyDispatches,
  refreshSymphony,
} from './client';
import { buildCards } from './transform';
import type {
  SymphonyCard,
  SymphonyDispatchActionResponse,
  SymphonyDispatchRow,
  SymphonyStateResponse,
} from './types';

const POLL_MS = 5000;

const stateKey = ['symphony', 'state'] as const;
const dispatchesKey = ['symphony', 'dispatches'] as const;

export function useSymphonyState(): {
  data: SymphonyStateResponse | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const q = useQuery({
    queryKey: stateKey,
    queryFn: ({ signal }) => getSymphonyState(signal),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
  return { data: q.data, isLoading: q.isLoading, error: q.error };
}

export function useSymphonyDispatches(limit = 200): {
  data: SymphonyDispatchRow[] | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const q = useQuery({
    queryKey: [...dispatchesKey, { limit }],
    queryFn: ({ signal }) => listSymphonyDispatches({ limit, signal }),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
  return { data: q.data, isLoading: q.isLoading, error: q.error };
}

export function useSymphonyCards(): {
  cards: SymphonyCard[];
  isLoading: boolean;
  error: Error | null;
} {
  const state = useSymphonyState();
  const dispatches = useSymphonyDispatches();
  const cards = useMemo(
    () => buildCards(state.data, dispatches.data),
    [state.data, dispatches.data]
  );
  return {
    cards,
    isLoading: state.isLoading || dispatches.isLoading,
    error: state.error ?? dispatches.error,
  };
}

interface SymphonyActions {
  dispatchNow: (dispatchKey: string) => Promise<SymphonyDispatchActionResponse>;
  cancelNow: (dispatchKey: string) => Promise<SymphonyDispatchActionResponse>;
  refresh: () => Promise<void>;
  isDispatching: boolean;
  isCancelling: boolean;
  isRefreshing: boolean;
}

export function useSymphonyActions(): SymphonyActions {
  const qc = useQueryClient();
  const invalidate = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: ['symphony'] }).then(() => undefined);

  const dispatchM = useMutation({
    mutationFn: (key: string) => dispatchSymphony(key),
    onSettled: invalidate,
  });
  const cancelM = useMutation({
    mutationFn: (key: string) => cancelSymphony(key),
    onSettled: invalidate,
  });
  const refreshM = useMutation({
    mutationFn: () => refreshSymphony(),
    onSettled: invalidate,
  });

  return {
    dispatchNow: key => dispatchM.mutateAsync(key),
    cancelNow: key => cancelM.mutateAsync(key),
    refresh: async (): Promise<void> => {
      await refreshM.mutateAsync();
    },
    isDispatching: dispatchM.isPending,
    isCancelling: cancelM.isPending,
    isRefreshing: refreshM.isPending,
  };
}
