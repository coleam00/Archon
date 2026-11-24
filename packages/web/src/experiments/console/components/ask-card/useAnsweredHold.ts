import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NeedsYouItem } from '../../lib/needs-you';

/** How long an answered card stays, saying what was answered, before it folds away. */
export const ANSWERED_SHOWN_MS = 5_000;
/** The fold's own length, at the end of that time; under reduced motion the card just goes. */
const ANSWERED_FOLD_MS = 300;

interface Held {
  ask: NeedsYouItem;
  label: string;
  folding: boolean;
  /** Where its card was drawn when it was answered. */
  index: number;
}

/** What a list of ask cards draws, with the answers it still shows. */
export interface AnsweredHold {
  /** The live asks, with each answered one still held in its place. */
  asks: NeedsYouItem[];
  /** The words each held ask was answered with, by ref. */
  answered: ReadonlyMap<string, string>;
  /** Refs whose card is folding away now. */
  folding: ReadonlySet<string>;
  onAnswered: (ask: NeedsYouItem, label: string) => void;
}

/**
 * Keeps an answered card on screen for `ANSWERED_SHOWN_MS`, saying "Answered: <label>", then
 * folds it away. Answering refreshes the queue, which drops the ask at once; without this the
 * card would unmount before its result is seen. A held ask is drawn where its card was when it
 * was answered, so it does not jump.
 */
export function useAnsweredHold(live: readonly NeedsYouItem[]): AnsweredHold {
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // The refs last drawn, in order, so an answered card keeps its place.
  const drawn = useRef<readonly string[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return (): void => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
  const later = useCallback((ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  }, []);
  const onAnswered = useCallback(
    (ask: NeedsYouItem, label: string): void => {
      const index = Math.max(0, drawn.current.indexOf(ask.ref));
      setHeld(current => new Map(current).set(ask.ref, { ask, label, folding: false, index }));
      later(ANSWERED_SHOWN_MS - ANSWERED_FOLD_MS, () => {
        setHeld(current => {
          const entry = current.get(ask.ref);
          return entry === undefined
            ? current
            : new Map(current).set(ask.ref, { ...entry, folding: true });
        });
      });
      later(ANSWERED_SHOWN_MS, () => {
        setHeld(current => {
          const next = new Map(current);
          next.delete(ask.ref);
          return next;
        });
      });
    },
    [later]
  );
  const hold = useMemo(() => {
    const liveRefs = new Set(live.map(ask => ask.ref));
    const asks = [...live];
    const gone = [...held.values()]
      .filter(entry => !liveRefs.has(entry.ask.ref))
      .sort((a, b) => a.index - b.index);
    for (const entry of gone) asks.splice(Math.min(entry.index, asks.length), 0, entry.ask);
    return {
      asks,
      answered: new Map([...held].map(([ref, entry]) => [ref, entry.label])),
      folding: new Set([...held].filter(([, entry]) => entry.folding).map(([ref]) => ref)),
      onAnswered,
    };
  }, [live, held, onAnswered]);
  drawn.current = hold.asks.map(ask => ask.ref);
  return hold;
}
