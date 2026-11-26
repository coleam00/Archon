/** The board cards' shared state (`FactoryCards.tsx` provides it). */
import { createContext, useContext } from 'react';
import type { AskRead } from './lib/item-asks';
import type { CardPack } from './lib/item-card';

export interface FactoryCards {
  projectId: string;
  /** Null while the packs are read or when they could not be. */
  packs: ReadonlyMap<string, CardPack> | null;
  packsError: boolean;
  /**
   * The project's asks, which each card and its column header count by one rule
   * (`lib/item-asks.ts`); `reading` or `failed` until they are known.
   */
  itemAsks: AskRead;
}

export const CardsContext = createContext<FactoryCards | null>(null);

export function useFactoryCards(): FactoryCards | null {
  return useContext(CardsContext);
}
