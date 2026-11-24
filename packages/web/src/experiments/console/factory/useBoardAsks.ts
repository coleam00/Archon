import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { itemAsks, type NeedsYouItem } from '../lib/needs-you';
import type { AttentionQueue } from '../skills/runs';
import { recentlySettled } from './lib/answered';
import type { BoardModel, FactoryDeclaration, PlacedCard } from './lib/board';
import {
  answeredLine,
  answerStands,
  boardAskFace,
  heldAnswer,
  type BoardAskFace,
  type HeldAnswer,
} from './lib/board-ask';

/** The ask popover open on the board: whose asks, and the control that opened it. */
export interface OpenAsk {
  key: string;
  trigger: HTMLElement;
}

/**
 * The board's asks, by item key: what each card's face says, which item's popover is open, and
 * the answers given from the board that a card still shows. The board owns this rather than a
 * card, so a card that remounts in another column keeps it.
 */
export interface BoardAsks {
  /** The item's open asks on the project's queue (`itemAsks`); null while the queue is unread. */
  asksOf: (key: string) => NeedsYouItem[] | null;
  /**
   * The card's face for its open asks; `unread` when the item's progress could not be read,
   * which the card still says beside it. Null when the queue holds nothing for the item.
   */
  faceOf: (key: string) => { face: BoardAskFace; unread: boolean } | null;
  /** What a card says for an answer given from the board; null when none stands. */
  answeredLine: (key: string) => string | null;
  open: OpenAsk | null;
  /** Opens the item's popover, or closes it when it is the one open. */
  openFor: (key: string, trigger: HTMLElement) => void;
  close: () => void;
  /** The item's last open ask was answered in the popover: the card holds the answer, and it closes. */
  settle: (key: string, ask: NeedsYouItem, label: string) => void;
}

/** Each placed card on the board's columns, by item key. */
function cardsByKey(model: BoardModel | undefined): Map<string, PlacedCard> {
  return new Map(
    (model?.columns ?? []).flatMap(column => column.cards.map(placed => [placed.card.key, placed]))
  );
}

/**
 * Focus back where the popover was opened from: the control itself, else the card's face or
 * Answer button drawn again under the same key, else the item's link. When the item has left
 * the board there is nothing to return to, and focus stays where it is.
 */
function focusBack({ key, trigger }: OpenAsk): void {
  if (trigger.isConnected) {
    trigger.focus();
    return;
  }
  const byKey = (selector: string, attribute: string): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      element => element.getAttribute(attribute) === key
    );
  const again = byKey('[data-ask-trigger]', 'data-ask-trigger');
  const card = byKey('[data-card]', 'data-card');
  (again ?? card?.querySelector<HTMLElement>('a'))?.focus();
}

/**
 * `all` is the unfiltered board (answers stand by where an item sits, filter or not); `shown`
 * the board the filter leaves, so a popover closes when its item is filtered away or leaves.
 */
export function useBoardAsks({
  all,
  shown,
  queue,
  declaration,
}: {
  all: BoardModel | undefined;
  shown: BoardModel | undefined;
  queue: AttentionQueue | undefined;
  declaration: FactoryDeclaration;
}): BoardAsks {
  const cards = useMemo(() => cardsByKey(all), [all]);
  const asks = useMemo(() => {
    if (queue === undefined) return undefined;
    return new Map([...cards].map(([key, placed]) => [key, itemAsks(placed.item, queue.items)]));
  }, [cards, queue]);
  const [held, setHeld] = useState<ReadonlyMap<string, HeldAnswer>>(new Map());
  const [open, setOpen] = useState<OpenAsk | null>(null);
  const opened = useRef<OpenAsk | null>(null);
  opened.current = open;
  const returnTo = useRef<OpenAsk | null>(null);

  const asksOf = useCallback(
    (key: string): NeedsYouItem[] | null => (asks === undefined ? null : (asks.get(key) ?? [])),
    [asks]
  );
  const stands = useCallback(
    (key: string, entry: HeldAnswer): boolean => {
      // Once the card has its own line to say (the restart failed, or its progress could not
      // be read), the answer gives way to it: the card never reads as healthy over a stop.
      // While it still needs you, its stop line is the ask just answered, so the answer wins.
      const card = cards.get(key)?.card;
      if (card !== undefined && card.pill !== 'needs-you' && card.stopLine !== null) return false;
      return answerStands(entry, all?.positions.get(key), asks?.get(key) ?? []);
    },
    [all, asks, cards]
  );
  // An answer that no longer stands goes, so a card that moves back later does not show it again.
  useEffect(() => {
    if ([...held].every(([key, entry]) => stands(key, entry))) return;
    setHeld(current => new Map([...current].filter(([key, entry]) => stands(key, entry))));
  }, [held, stands]);

  const close = useCallback((): void => {
    if (opened.current !== null) returnTo.current = opened.current;
    setOpen(null);
  }, []);
  // After the board has drawn without the popover, so the card's own controls are back.
  useEffect(() => {
    if (open !== null || returnTo.current === null) return;
    const back = returnTo.current;
    returnTo.current = null;
    focusBack(back);
  }, [open]);
  const shownKeys = useMemo(() => new Set(cardsByKey(shown).keys()), [shown]);
  const openKey = open?.key;
  // Gone from the board or the filter, or nothing left to answer (answered elsewhere).
  const openGone =
    openKey !== undefined && (!shownKeys.has(openKey) || asks?.get(openKey)?.length === 0);
  useEffect(() => {
    if (openGone) close();
  }, [openGone, close]);

  return {
    asksOf,
    faceOf: key => {
      const face = boardAskFace(asksOf(key) ?? []);
      if (face === null) return null;
      return { face, unread: cards.get(key)?.item.progress === null };
    },
    answeredLine: key => {
      const entry = held.get(key);
      const placed = cards.get(key);
      if (entry === undefined || placed === undefined || !stands(key, entry)) return null;
      return answeredLine(
        entry,
        recentlySettled(declaration, [placed.item], Number.POSITIVE_INFINITY)
      );
    },
    open,
    openFor: (key, trigger) => {
      if (opened.current?.key === key) close();
      else setOpen({ key, trigger });
    },
    close,
    settle: (key, ask, label) => {
      const entry = heldAnswer(ask, label, all?.positions.get(key), asksOf(key) ?? [ask]);
      setHeld(current => new Map(current).set(key, entry));
      close();
    },
  };
}
