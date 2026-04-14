import { createContext, useContext } from 'react';

export interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  pinned: boolean;
  togglePin: () => void;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const MobileNavContext = createContext<MobileNavContextValue>({
  open: false,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setOpen: () => {},
  pinned: true,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  togglePin: () => {},
});

export function useMobileNav(): MobileNavContextValue {
  return useContext(MobileNavContext);
}
