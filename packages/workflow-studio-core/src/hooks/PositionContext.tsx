import { createContext, useContext, type ReactNode } from 'react';
import type { UsePositionPersistence } from './usePositionPersistence';

const positionContext = createContext<UsePositionPersistence | null>(null);

export function PositionProvider({
  value,
  children,
}: {
  value: UsePositionPersistence;
  children: ReactNode;
}): JSX.Element {
  return <positionContext.Provider value={value}>{children}</positionContext.Provider>;
}

export function usePositionContext(): UsePositionPersistence {
  const ctx = useContext(positionContext);
  if (!ctx) {
    throw new Error(
      'usePositionContext: missing <PositionProvider>. Wrap descendants of WorkflowBuilder.'
    );
  }
  return ctx;
}
