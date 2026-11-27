import { useState } from 'react';

export interface ShownSendBacks {
  /** The card whose send-backs the map lights now, the others dimmed; null for none. */
  shown: string | null;
  /** The pointer entered or left a card. */
  hover: (card: string | null) => void;
  /** Keyboard focus moved into a card, or out of every card. */
  focus: (card: string | null) => void;
}

/**
 * Which card's send-backs the map lights: the card under the pointer, else the one holding
 * keyboard focus. The map draws every send-back whatever this says (`MapSendBacks`); lighting
 * one card's only dims the others, so nothing needs a hover to be seen.
 */
export function useShownSendBacks(): ShownSendBacks {
  const [hovered, hover] = useState<string | null>(null);
  const [focused, focus] = useState<string | null>(null);
  return { shown: hovered ?? focused, hover, focus };
}
