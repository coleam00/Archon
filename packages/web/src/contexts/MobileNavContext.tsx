import { createContext, useContext } from 'react';

export interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const MobileNavContext = createContext<MobileNavContextValue>({
  open: false,
  setOpen: () => {},
});

export function useMobileNav(): MobileNavContextValue {
  return useContext(MobileNavContext);
}
