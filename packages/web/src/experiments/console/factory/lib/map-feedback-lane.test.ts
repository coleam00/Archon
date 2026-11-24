import { describe, expect, test } from 'bun:test';
import { feedbackLane, type LaneCard, type SendBack } from './map-feedback-lane';
import {
  boxesMeet,
  crosses,
  enters,
  horizontal,
  pointSegments,
  segments,
} from './map-geometry.test-fixtures';
import { CARD_H, CARD_W, LANE } from './map-sizes';

/** Four cards in a row, the second holding two stages. */
const PITCH = CARD_W + 64;
const cards = new Map<string, LaneCard>(
  [['a'], ['b1', 'b2'], ['c'], ['d']].map((stages, i): [string, LaneCard] => [
    `card${i.toString()}`,
    { box: { x: i * PITCH, y: 0, w: CARD_W, h: CARD_H }, stages },
  ])
);
const Y = CARD_H + LANE;

const sendBack = (from: string, to: string, label: string): SendBack => ({
  id: `${from}->${to}:${label}`,
  from,
  to,
  label,
});
const SEND_BACKS: SendBack[] = [
  sendBack('card2', 'b2', 'returned'),
  sendBack('card3', 'b2', 'returned'),
  sendBack('card3', 'b2', 'landing failed'),
  sendBack('card2', 'b1', 'replan'),
  sendBack('card1', 'b1', 'answers'),
  sendBack('card3', 'a', 'start over'),
];
const lane = feedbackLane(cards, Y, SEND_BACKS);

describe('the feedback lane', () => {
  test('every send-back leaves its card on the card one source leg and rises into its stage leg', () => {
    const legOf = new Map<string, number>();
    for (const path of lane.paths) {
      const [down, run, up] = segments(path.d);
      expect(down?.x1).toBe((cards.get(path.from)?.box.x ?? Number.NaN) + CARD_W * 0.85);
      expect(down?.y1).toBe(CARD_H);
      expect(down?.y2).toBe(Y);
      expect(run !== undefined && horizontal(run)).toBe(true);
      expect(run?.x2).toBeLessThan(run?.x1 ?? 0);
      expect(up?.y2).toBe(CARD_H);
      const seen = legOf.get(path.to);
      if (seen !== undefined) expect(up?.x1).toBe(seen);
      legOf.set(path.to, up?.x1 ?? 0);
    }
    // Two stages of one card returned to: two legs on its left 0.1-0.6, in its stage order.
    const left = cards.get('card1')?.box.x ?? 0;
    const b1 = legOf.get('b1') ?? 0;
    const b2 = legOf.get('b2') ?? 0;
    expect(b1).toBeLessThan(b2);
    expect(b1).toBeGreaterThan(left + CARD_W * 0.1);
    expect(b2).toBeLessThan(left + CARD_W * 0.6);
  });

  test('one pill per target stage, its outcomes each once in declared order', () => {
    expect(lane.pills.map(pill => [pill.stage, pill.text])).toEqual([
      ['a', 'start over'],
      ['b1', 'replan, answers'],
      ['b2', 'returned, landing failed'],
    ]);
  });

  test('pills sit under the lane on bands, meeting no other pill', () => {
    for (const pill of lane.pills) expect(pill.box.y).toBeGreaterThan(Y);
    lane.pills.forEach((pill, i) =>
      lane.pills.forEach((other, j) => {
        if (i !== j) expect(boxesMeet(pill.box, other.box)).toBe(false);
      })
    );
    // b1 and b2's pills are wider than the room between their legs: one drops a band.
    const [, b1, b2] = lane.pills;
    expect(b2?.box.y).toBeGreaterThan(b1?.box.y ?? 0);
  });

  test('the strokes draw each piece once: every send-back route lies on them, none crossing', () => {
    const drawn = lane.strokes.flatMap(stroke => pointSegments(stroke.points));
    const onDrawn = (x: number, y: number): boolean =>
      drawn.some(
        s =>
          x >= Math.min(s.x1, s.x2) &&
          x <= Math.max(s.x1, s.x2) &&
          y >= Math.min(s.y1, s.y2) &&
          y <= Math.max(s.y1, s.y2)
      );
    for (const path of lane.paths)
      for (const s of segments(path.d)) {
        expect(onDrawn(s.x1, s.y1)).toBe(true);
        expect(onDrawn(s.x2, s.y2)).toBe(true);
        expect(onDrawn((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2)).toBe(true);
      }
    // The lane's runs overlap, so they are drawn as one: one horizontal piece on the lane.
    expect(drawn.filter(s => horizontal(s) && s.y1 === Y)).toHaveLength(1);
    for (const p of drawn) for (const q of drawn) expect(crosses(p, q)).toBe(false);
    for (const s of drawn)
      for (const card of cards.values()) expect(enters(card.box, s)).toBe(false);
  });

  test('every target leg ends in a head into its card; a source leg does not', () => {
    const heads = lane.strokes.filter(stroke => stroke.head).map(stroke => stroke.points.at(-1));
    for (const head of heads) expect(head?.y).toBe(CARD_H);
    expect(heads).toHaveLength(3);
  });

  test('a send-back whose card or stage is not drawn is left out; none, no extent', () => {
    const missing = feedbackLane(cards, Y, [
      sendBack('card9', 'a', 'x'),
      sendBack('card2', 'zz', 'y'),
    ]);
    expect(missing.paths).toEqual([]);
    expect(missing.extent).toBeUndefined();
  });
});
