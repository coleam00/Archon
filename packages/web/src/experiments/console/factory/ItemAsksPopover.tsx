/**
 * The ask view over the board: one item's open asks as Archon's own ask section draws them
 * (`ItemAsksSection`, Visual standard rule 9), answered in place. From md up it sits beside the
 * card that opened it, or at the window's left edge when there is no room beside it
 * (`popoverPlace`); under md it is a sheet from the bottom. Esc and a press outside close it,
 * and focus returns to the control that opened it. Ported from v1 (`origin/main`).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ItemAsksSection } from '../components/ItemAsksSection';
import { useFactoryCards, type OpenAsks } from './cards-context';
import { popoverPlace } from './lib/popover-place';

// console-token-exception md:max-h-[calc(100vh-32px)] -- beside a card the popover keeps 16 px from the window's top and bottom, as popoverPlace places it.
const TALLEST = 'md:max-h-[calc(100vh-32px)]';
// console-token-exception md:w-[480px] -- Visual standard rule 9: the ask view is at most 480 px wide over the board.
const WIDTH = 'md:w-[480px]';
const SHELL = `console-root fixed z-50 flex flex-col gap-3 overflow-y-auto rounded-console-12 border border-border-bright bg-surface-elevated p-3 text-text-primary shadow-lg max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[85vh] max-md:rounded-b-none ${TALLEST}`;

/** Tailwind's md breakpoint: from here the popover sits beside its card; under it, a sheet. */
const WIDE = '(min-width: 48rem)';

function usePlace(
  box: RefObject<HTMLDivElement | null>,
  trigger: HTMLElement
): { top: number; left: number } | null {
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const update = (): void => {
      // Answering the last ask can take the card's button away while the popover is open.
      if (!trigger.isConnected) return;
      if (typeof window.matchMedia === 'function' && !window.matchMedia(WIDE).matches) {
        setPlace(null);
        return;
      }
      const anchor = (trigger.closest('[data-item]') ?? trigger).getBoundingClientRect();
      const next = popoverPlace(
        anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      );
      setPlace(current =>
        current?.top === next.top && current.left === next.left ? current : next
      );
    };
    update();
    window.addEventListener('resize', update);
    // Capture: the board's row scrolls on its own, and scroll does not bubble.
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return (): void => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [box, trigger]);
  return place;
}

/** Closes on Esc and on a press outside the popover and its trigger, returning focus to it. */
function useDismiss(
  box: RefObject<HTMLDivElement | null>,
  trigger: HTMLElement,
  close: () => void
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
      trigger.focus({ preventScroll: true });
    };
    const onPress = (event: MouseEvent): void => {
      const path = event.composedPath();
      if (path.includes(trigger) || (box.current !== null && path.includes(box.current))) return;
      close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPress);
    return (): void => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPress);
    };
  }, [box, trigger, close]);
}

export function ItemAsksPopover(): ReactElement | null {
  const cards = useFactoryCards();
  if (cards?.open == null || cards.itemAsks === null) return null;
  return (
    <Popover
      key={cards.open.read.item.id}
      open={cards.open}
      close={() => {
        cards.setOpen(null);
      }}
    />
  );
}

function Popover({ open, close }: { open: OpenAsks; close: () => void }): ReactElement | null {
  const cards = useFactoryCards();
  const box = useRef<HTMLDivElement>(null);
  const place = usePlace(box, open.trigger);
  useDismiss(box, open.trigger, close);
  useEffect(() => {
    box.current
      ?.querySelector<HTMLElement>('button, textarea, input')
      ?.focus({ preventScroll: true });
  }, []);
  const itemAsks = cards?.itemAsks;
  if (itemAsks == null) return null;
  const id = open.read.item.id;
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-label={`Asks on ${open.keyText}`}
      data-item-asks-popover={id}
      style={place == null ? undefined : { top: place.top, left: place.left }}
      className={SHELL}
    >
      <div className={`flex w-full flex-col gap-3 ${WIDTH}`}>
        <p className="line-clamp-2 text-console-13 font-semibold text-text-secondary">
          <span className="font-mono">{open.keyText}</span>
          {open.title === open.keyText ? null : ` ${open.title}`}
        </p>
        <ItemAsksSection
          {...itemAsks}
          asks={itemAsks.asks.filter(ask => ask.item?.id === id)}
          answered={itemAsks.answered.filter(record => record.ask.item?.id === id)}
          showProject={false}
        />
      </div>
    </div>,
    document.body
  );
}
