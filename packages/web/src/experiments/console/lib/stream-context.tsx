import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

/**
 * Context for per-stream data that every entry needs but we don't want to
 * prop-drill through five layers.
 *
 * `runStartedAt` drives relative timestamps like `+04:12`.
 */
export interface StreamContextValue {
  runStartedAt: string | null;
}

const context = createContext<StreamContextValue>({ runStartedAt: null });

// Wrap Provider as a function so naming-convention allows PascalCase.
export function StreamContextProvider({
  value,
  children,
}: {
  value: StreamContextValue;
  children: ReactNode;
}): ReactElement {
  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useStreamContext(): StreamContextValue {
  return useContext(context);
}
