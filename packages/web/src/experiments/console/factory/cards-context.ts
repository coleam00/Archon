/** The board cards' shared state (`FactoryCards.tsx` provides it). */
import { createContext, useContext } from 'react';
import type { ItemAsks } from '../components/ItemAsksSection';
import type { CardPack } from './lib/item-card';

export interface FactoryCards {
  projectId: string;
  /** Null while the packs are read or when they could not be. */
  packs: ReadonlyMap<string, CardPack> | null;
  packsError: boolean;
  /** The project's asks; each card counts its item's open ones. */
  itemAsks: ItemAsks | null;
}

export const CardsContext = createContext<FactoryCards | null>(null);

export function useFactoryCards(): FactoryCards | null {
  return useContext(CardsContext);
}
