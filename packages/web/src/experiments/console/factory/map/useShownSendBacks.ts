import { useEffect, useState } from 'react';

export interface ShownSendBacks {
  /** The card whose send-backs the map draws now; null for none. */
  shown: string | null;
  /** The card pinned by its ↺ badge; null for none. */
  pinned: string | null;
  /** The pointer entered or left a card. */
  hover: (card: string | null) => void;
  /** Keyboard focus moved into a card, or out of every card. */
  focus: (card: string | null) => void;
  /** A press on a card's ↺ badge: pin its send-backs, or unpin and hide them. */
  toggle: (card: string) => void;
}

/**
 * Which card's send-backs the map shows: the card under the pointer, else the one holding
 * keyboard focus, else the one pinned by its ↺ badge, the touch and keyboard control (a click on a card
 * already opens its stage). A pin holds while the map is dragged: the frame's pan starts on
 * a press, so only a real click elsewhere unpins, and the click a drag ends in never arrives
 * (`useMapCamera` swallows it). A click on a pill's tip (`MapPillTips`, whose route pills
 * exist only while their card shows) keeps it too, as does one on the zoom controls. Escape
 * unpins, unless something else takes it: then Escape only closes that (the owner's ruling on
 * #289). The stage modal takes it while it is open; `escapeTaken` says the map's own details
 * panel does. The listener runs in the capture phase, before the modal's own handler closes it.
 */
export function useShownSendBacks(escapeTaken: boolean): ShownSendBacks {
  const [hovered, hover] = useState<string | null>(null);
  const [focused, focus] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);

  useEffect(() => {
    if (pinned === null) return;
    const onClick = (event: MouseEvent): void => {
      const target = event.target as Partial<Element> | null;
      if (target?.closest?.('[data-send-back-badge], [data-pill-tip], [data-map-controls]') == null)
        setPinned(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || escapeTaken) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      setPinned(null);
    };
    document.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [pinned, escapeTaken]);

  return {
    shown: hovered ?? focused ?? pinned,
    pinned,
    hover,
    focus,
    toggle: card => {
      if (pinned !== card) {
        setPinned(card);
        return;
      }
      // Unpinning hides the routes even with the pointer or focus still on the card: a touch
      // tap leaves the card hovered (its emulated mouseover), so the press would do nothing.
      setPinned(null);
      hover(current => (current === card ? null : current));
      focus(current => (current === card ? null : current));
    },
  };
}
