import { createContext, useContext } from 'react';

export interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const MobileNavContext = createContext<MobileNavContextValue>({
  open: false,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setOpen: () => {},
});

export function useMobileNav(): MobileNavContextValue {
  return useContext(MobileNavContext);
}
