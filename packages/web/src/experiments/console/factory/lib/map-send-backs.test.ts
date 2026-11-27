import { describe, expect, test } from 'bun:test';
import { sendBackRoutes, type RouteCard, type SendBackArrow } from './map-send-backs';
import { boxesMeet, crosses, enters, overlaps, segments } from './map-geometry.test-fixtures';

/** Four cards in a row; the second and third hold two stages each. */
const [CARD_W, CARD_H] = [184, 168];
const PITCH = CARD_W + 64;
const cards = new Map<string, RouteCard>(
  [['a'], ['b1', 'b2'], ['c1', 'c2'], ['d']].map((stages, i): [string, RouteCard] => [
    `card${i.toString()}`,
    { box: { x: i * PITCH, y: 0, w: CARD_W, h: CARD_H }, stages },
  ])
);
const cardOf = (stage: string): string =>
  [...cards].find(([, card]) => card.stages.includes(stage))?.[0] ?? '';

const sendBack = (from: string, to: string, words: string[]): SendBackArrow => ({
  id: `${from}>${to}`,
  card: cardOf(from),
  from,
  to,
  words,
});
const SEND_BACKS: SendBackArrow[] = [
  // Two stages of one card return to the same stage: two routes.
  sendBack('c1', 'b2', ['returned']),
  sendBack('c2', 'b2', ['returned', 'one more round', 'behind']),
  sendBack('c2', 'a', ['start over']),
  // Inside one card, into its own stage.
  sendBack('c1', 'c1', ['again']),
  sendBack('d', 'b1', ['replan', 'asked']),
  sendBack('d', 'd', []),
  sendBack('b2', 'b1', ['answers']),
  sendBack('a', 'a', ['something else']),
];
const label = (stage: string): string => stage.toUpperCase();
const routes = sendBackRoutes(cards, SEND_BACKS, label);
const all = [...routes.values()].flatMap(card => card.routes);

describe("each card's send-backs", () => {
  test('one route per pair of stages, nothing merged, counted per card', () => {
    expect(all.map(route => route.id).sort()).toEqual(SEND_BACKS.map(entry => entry.id).sort());
    expect(
      Object.fromEntries([...routes].map(([card, { routes: mine }]) => [card, mine.length]))
    ).toEqual({ card0: 1, card1: 1, card2: 4, card3: 2 });
  });

  test("each starts on its card's bottom edge and ends on its target stage's card's", () => {
    for (const route of all) {
      const source = cards.get(route.card)?.box;
      const target = cards.get(cardOf(route.to))?.box;
      const first = route.points[0];
      const last = route.points.at(-1);
      if (source === undefined || target === undefined || !first || !last)
        throw new Error(`no card for ${route.id}`);
      expect(first.y).toBe(CARD_H);
      expect(first.x).toBeGreaterThan(source.x);
      expect(first.x).toBeLessThan(source.x + source.w);
      expect(last.y).toBe(CARD_H);
      expect(last.x).toBeGreaterThan(target.x);
      expect(last.x).toBeLessThan(target.x + target.w);
    }
  });

  test("no route enters a card, and a card's routes never cross, run along each other or share a leg", () => {
    for (const [, { routes: mine }] of routes) {
      const lines = mine.map(route => segments(route.d));
      for (const s of lines.flat())
        for (const card of cards.values()) expect(enters(card.box, s)).toBe(false);
      lines.forEach((p, i) =>
        lines.forEach((q, j) => {
          if (i === j) return;
          for (const s of p)
            for (const t of q) {
              expect(crosses(s, t)).toBe(false);
              // Each route on its own line: none runs along another's.
              expect(overlaps(s, t)).toBe(false);
            }
        })
      );
      const legs = mine.flatMap(route => [route.points[0]?.x, route.points.at(-1)?.x]);
      expect(new Set(legs).size).toBe(legs.length);
    }
  });

  test("pills meet no pill, card or line of their card, and stay within the row's span", () => {
    const row = { lo: 0, hi: 3 * PITCH + CARD_W };
    for (const [, { routes: mine, extent }] of routes) {
      const pills = mine.flatMap(route => (route.pill === undefined ? [] : [route.pill.box]));
      const lines = mine.flatMap(route => segments(route.d));
      pills.forEach((pill, i) => {
        expect(pill.x).toBeGreaterThanOrEqual(row.lo);
        expect(pill.x + pill.w).toBeLessThanOrEqual(row.hi);
        for (const card of cards.values()) expect(boxesMeet(pill, card.box)).toBe(false);
        for (const s of lines) expect(enters(pill, s)).toBe(false);
        pills.forEach((other, j) => {
          if (i !== j) expect(boxesMeet(pill, other)).toBe(false);
        });
        expect(pill.y + pill.h).toBeLessThanOrEqual(extent.y + extent.h);
      });
    }
  });

  test('each pill sits near its own leg: never more than a short slide from it', () => {
    for (const route of all) {
      const pill = route.pill?.box;
      const leg = route.points.at(-1)?.x;
      if (pill === undefined || leg === undefined) continue;
      // The gap between the leg and the nearer edge of its pill.
      const gap = Math.max(0, pill.x - leg, leg - (pill.x + pill.w));
      expect(gap).toBeLessThanOrEqual(120);
    }
  });

  test('a pill names its words, and which stages it joins where a card holds several', () => {
    const pill = (id: string): string[] | undefined =>
      all.find(route => route.id === id)?.pill?.lines;
    expect(pill('c1>b2')).toEqual(['returned', 'C1 → B2']);
    expect(pill('c2>b2')).toEqual(['returned +2', 'C2 → B2']);
    expect(pill('c2>a')).toEqual(['start over', 'C2 → A']);
    expect(pill('d>b1')).toEqual(['replan, asked', 'D → B1']);
    // Both ends on cards of one stage: the words say it all.
    expect(pill('a>a')).toEqual(['something else']);
    // Nothing to say, nothing drawn.
    expect(all.find(route => route.id === 'd>d')?.pill).toBeUndefined();
  });
});
