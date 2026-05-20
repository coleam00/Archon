import { createContext, useContext, type ReactNode } from 'react';
import type { WorkflowApiClient } from './WorkflowApiClient';

const apiClientContext = createContext<WorkflowApiClient | null>(null);

export function ApiClientProvider({
  client,
  children,
}: {
  client: WorkflowApiClient;
  children: ReactNode;
}): JSX.Element {
  return <apiClientContext.Provider value={client}>{children}</apiClientContext.Provider>;
}

export function useWorkflowApi(): WorkflowApiClient {
  const ctx = useContext(apiClientContext);
  if (!ctx) throw new Error('useWorkflowApi must be used inside <ApiClientProvider>');
  return ctx;
}
