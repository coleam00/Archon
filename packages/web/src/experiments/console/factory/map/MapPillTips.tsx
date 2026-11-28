import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { Box, MapLayout } from '../lib/map-layout';
import { tipShift } from '../lib/tip-shift';

/** A pill on the map that shows fewer outcomes than its line carries ("built +2"). */
export interface ShortPill {
  id: string;
  pill: Box;
  /** What the line joins, for its button's name. */
  name: string;
  outcomes: readonly string[];
}

/**
 * The map's short pills: every line's whose pill shows fewer outcomes than it carries, a
 * forward hand-off's or a send-back's. The map draws every send-back always, so each of their
 * tips can be reached.
 */
export function shortPills(layout: Pick<MapLayout, 'cards' | 'arrows' | 'sendBacks'>): ShortPill[] {
  const label = (id: string): string => layout.cards.find(card => card.id === id)?.label ?? id;
  const forward = layout.arrows.flatMap(arrow =>
    arrow.pill === undefined || arrow.outcomes.length <= arrow.lines.length
      ? []
      : [
          {
            id: arrow.id,
            pill: arrow.pill,
            name: `${label(arrow.from)} to ${label(arrow.to)}`,
            outcomes: arrow.outcomes,
          },
        ]
  );
  const routes = [...layout.sendBacks.values()].flatMap(card => card.routes);
  const back = routes.flatMap(route =>
    route.pill === undefined || !route.pill.shortened
      ? []
      : [
          {
            id: route.id,
            pill: route.pill.box,
            name: `${label(route.from)} back to ${label(route.to)}`,
            outcomes: route.reasons,
          },
        ]
  );
  return [...forward, ...back];
}

/**
 * Every outcome of a line whose pill shows fewer than it has: a forward hand-off's, or a
 * send-back's. A button laid exactly over the pill, which opens a tip listing them on
 * hover, on focus and on a tap. HTML rather than part of the SVG: the map's lines are
 * `aria-hidden` and take no pointer, and a tap or the keyboard has to reach the list. Drawn
 * after the cards, so no card's box covers a button. A press on one still starts a pan of the
 * map: it is not stopped here.
 */
export function MapPillTips({ pills }: { pills: readonly ShortPill[] }): ReactElement {
  return (
    <>
      {pills.map(pill => (
        <PillTip key={pill.id} {...pill} />
      ))}
    </>
  );
}

/**
 * One pill's button and tip. It opens on hover, focus or a click (which a tap sends; a tap need
 * not focus a button) and shuts on leave, blur, Escape or a press anywhere outside the pill.
 * The press outside is what shuts it after a tap, without counting on a touch browser to send
 * a mouseleave or a blur. Mouse enter and leave, not pointer ones: a touch's pointerleave comes
 * as the finger lifts and would shut the tip the tap just opened.
 */
function PillTip({
  id,
  pill,
  name,
  outcomes,
}: {
  id: string;
  pill: Box;
  name: string;
  outcomes: readonly string[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const tipId = `map-pill-tip-${id}`;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node | null) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <span
      ref={ref}
      className="absolute"
      style={{ left: pill.x, top: pill.y, width: pill.w, height: pill.h }}
    >
      <button
        type="button"
        data-pill-tip={id}
        aria-label={`${name}: ${outcomes.join(', ')}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onKeyDown={event => {
          // Escape shuts the tip first; the map's own Escape (the details panel) waits for the next.
          if (event.key !== 'Escape' || !open) return;
          event.stopPropagation();
          setOpen(false);
        }}
        className="absolute inset-0 cursor-help rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {open ? <Tip id={tipId} outcomes={outcomes} /> : null}
    </span>
  );
}

/**
 * The open tip: above the pill, where the map keeps room over the cards, over any card it
 * meets. Centred on the pill, then moved sideways as far as it must to stay inside the map's
 * frame, which clips it: on a phone the pill can sit at the frame's edge.
 */
function Tip({ id, outcomes }: { id: string; outcomes: readonly string[] }): ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const tip = ref.current;
    const frame = tip?.closest('[role="group"]');
    if (tip == null || frame == null) return;
    const box = tip.getBoundingClientRect();
    // The world layer is scaled; the shift is measured on screen and applied in world units.
    const k = tip.offsetWidth > 0 ? box.width / tip.offsetWidth : 1;
    setShift(tipShift(box, frame.getBoundingClientRect()) / k);
  }, []);
  return (
    <span
      ref={ref}
      id={id}
      role="tooltip"
      style={shift === 0 ? undefined : { marginLeft: shift }}
      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 flex -translate-x-1/2 flex-col whitespace-nowrap rounded-console-12 border border-border bg-surface-elevated px-2.5 py-1.5 text-console-12 text-text-secondary"
    >
      {outcomes.map(outcome => (
        <span key={outcome}>{outcome}</span>
      ))}
    </span>
  );
}
