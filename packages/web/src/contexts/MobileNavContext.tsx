import { createContext, useContext } from 'react';

export interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  pinned: boolean;
  togglePin: () => void;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export function useMobileNav(): MobileNavContextValue {
  const ctx = useContext(MobileNavContext);
  if (!ctx) throw new Error('useMobileNav must be used within MobileNavContext.Provider');
  return ctx;
}
