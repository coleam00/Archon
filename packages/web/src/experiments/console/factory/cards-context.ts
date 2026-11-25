/** The board cards' shared state (`FactoryCards.tsx` provides it). Split out so the popover can read it. */
import { createContext, useContext } from 'react';
import type { ItemAsks } from '../components/ItemAsksSection';
import type { ItemRead } from '../skills/items';
import type { CardPack } from './lib/item-card';

/** The item whose asks the popover shows, and the control that opened it (focus returns there). */
export interface OpenAsks {
  read: ItemRead;
  title: string;
  keyText: string;
  trigger: HTMLElement;
}

export interface FactoryCards {
  projectId: string;
  /** Null while the packs are read or when they could not be. */
  packs: ReadonlyMap<string, CardPack> | null;
  packsError: boolean;
  itemAsks: ItemAsks | null;
  open: OpenAsks | null;
  setOpen: (open: OpenAsks | null) => void;
}

export const CardsContext = createContext<FactoryCards | null>(null);

export function useFactoryCards(): FactoryCards | null {
  return useContext(CardsContext);
}
