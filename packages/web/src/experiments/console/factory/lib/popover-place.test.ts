import { expect, test } from 'bun:test';
import { popoverPlace } from './popover-place';

test('the popover sits right of the card when it fits, else left, always inside the window', () => {
  const viewport = { width: 1440, height: 900 };
  const box = { width: 480, height: 400 };
  const inside = (place: { top: number; left: number }) =>
    place.top >= 0 &&
    place.left >= 0 &&
    place.top + box.height <= viewport.height &&
    place.left + box.width <= viewport.width;
  const card = { top: 200, left: 300, right: 508, bottom: 340 };
  const right = popoverPlace(card, box, viewport);
  expect(right.left).toBeGreaterThan(card.right);
  const nearEdge = { top: 200, left: 1100, right: 1308, bottom: 340 };
  expect(popoverPlace(nearEdge, box, viewport).left + box.width).toBeLessThan(nearEdge.left);
  for (const top of [-40, 200, 800])
    expect(inside(popoverPlace({ ...card, top }, box, viewport))).toBe(true);
});
