import { describe, expect, test } from 'bun:test';
import { extentOf, sendBackRoutes, type RouteCard, type SendBackArrow } from './map-send-backs';
import { boxesMeet, crosses, enters, overlaps, segments } from './map-geometry.test-fixtures';

/** Four cards in a row. */
const [CARD_W, CARD_H] = [184, 168];
const PITCH = CARD_W + 64;
const LABELS = ['Intake', 'Plan and build', 'Checks', 'Landing'];
const cards = new Map<string, RouteCard>(
  LABELS.map((label, i): [string, RouteCard] => [
    `card${i.toString()}`,
    { box: { x: i * PITCH, y: 0, w: CARD_W, h: CARD_H }, label },
  ])
);

const sendBack = (from: number, to: number, words: string[]): SendBackArrow => ({
  id: `card${from.toString()}>card${to.toString()}`,
  from: `card${from.toString()}`,
  to: `card${to.toString()}`,
  words,
});
const SEND_BACKS: SendBackArrow[] = [
  // Checks goes back to two cards: two routes.
  sendBack(2, 1, ['returned', 'plan again', 'sent back', 'Other', 'one more round']),
  sendBack(2, 0, ['start over']),
  // Landing goes back to three.
  sendBack(3, 1, ['sent back', 'behind its branch']),
  sendBack(3, 0, []),
  sendBack(3, 2, ['Other']),
  // Into its own card: a retry, never drawn.
  sendBack(1, 1, ['answered']),
];
const routes = sendBackRoutes(cards, SEND_BACKS);
const all = [...routes.values()].flatMap(card => card.routes);

describe("each card's send-backs", () => {
  test('one route per pair of cards, none into its own card; a card with none has no entry', () => {
    expect(all.map(route => route.id).sort()).toEqual(
      SEND_BACKS.filter(entry => entry.from !== entry.to)
        .map(entry => entry.id)
        .sort()
    );
    expect(
      Object.fromEntries([...routes].map(([card, { routes: mine }]) => [card, mine.length]))
    ).toEqual({ card2: 2, card3: 3 });
  });

  test("each starts on its card's bottom edge and ends on its target stage's card's", () => {
    for (const route of all) {
      const source = cards.get(route.from)?.box;
      const target = cards.get(route.to)?.box;
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

  test('no route enters a card, runs along another or shares a leg; routes sharing a card never cross', () => {
    // Drawn all at once, laid out together. Interleaved routes (Checks to Intake, Landing to
    // Plan and build) cannot help crossing; any two that share a card nest instead.
    const lines = all.map(route => segments(route.d));
    for (const s of lines.flat())
      for (const card of cards.values()) expect(enters(card.box, s)).toBe(false);
    lines.forEach((p, i) =>
      lines.forEach((q, j) => {
        if (i === j) return;
        const [a, b] = [all[i], all[j]];
        const share = a?.from === b?.from || a?.to === b?.to;
        for (const s of p)
          for (const t of q) {
            if (share) expect(crosses(s, t)).toBe(false);
            // Each route on its own line: none runs along another's.
            expect(overlaps(s, t)).toBe(false);
          }
      })
    );
    const legs = all.flatMap(route => [route.points[0]?.x, route.points.at(-1)?.x]);
    expect(new Set(legs).size).toBe(legs.length);
    const tracks = all.map(route => route.points[1]?.y);
    expect(new Set(tracks).size).toBe(tracks.length);
  });

  test("pills meet no pill, card or line, and stay within the row's span", () => {
    const row = { lo: 0, hi: 3 * PITCH + CARD_W };
    const extent = extentOf(all);
    const pills = all.flatMap(route => (route.pill === undefined ? [] : [route.pill.box]));
    const lines = all.flatMap(route => segments(route.d));
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

  test('a pill says where it goes back to and why, in plain words', () => {
    const pill = (id: string): string[] | undefined =>
      all.find(route => route.id === id)?.pill?.lines;
    // "returned" and "sent back" only say the card sent it back: said once, by its name, first;
    // "Other" names no reason, so it goes last, into the "+N".
    expect(pill('card2>card1')).toEqual([
      'Back to Plan and build:',
      'Checks sent it back, plan again +2',
    ]);
    expect(all.find(route => route.id === 'card2>card1')?.reasons).toEqual([
      'Checks sent it back',
      'plan again',
      'one more round',
      'Other',
    ]);
    expect(pill('card2>card0')).toEqual(['Back to Intake:', 'start over']);
    expect(pill('card3>card1')).toEqual([
      'Back to Plan and build:',
      'Landing sent it back, behind its branch',
    ]);
    // No words: only where.
    expect(pill('card3>card0')).toEqual(['Back to Intake']);
    for (const route of all)
      for (const line of route.pill?.lines ?? []) {
        expect(line).not.toContain('→');
        expect(line).not.toMatch(/card\d/);
      }
  });
});
