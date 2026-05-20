export interface Guide {
  type: 'horizontal' | 'vertical';
  position: number;
}

interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function computeGuides(dragging: Rect, stationary: Rect[], threshold: number): Guide[] {
  const guides: Guide[] = [];
  const seen = new Set<string>();

  const addV = (x: number): void => {
    const key = `v:${x}`;
    if (!seen.has(key)) {
      seen.add(key);
      guides.push({ type: 'vertical', position: x });
    }
  };
  const addH = (y: number): void => {
    const key = `h:${y}`;
    if (!seen.has(key)) {
      seen.add(key);
      guides.push({ type: 'horizontal', position: y });
    }
  };

  const dLeft = dragging.x;
  const dRight = dragging.x + dragging.w;
  const dCenterX = dragging.x + dragging.w / 2;
  const dTop = dragging.y;
  const dBottom = dragging.y + dragging.h;
  const dCenterY = dragging.y + dragging.h / 2;

  for (const s of stationary) {
    if (s.id === dragging.id) continue;
    const sLeft = s.x,
      sRight = s.x + s.w,
      sCenterX = s.x + s.w / 2;
    const sTop = s.y,
      sBottom = s.y + s.h,
      sCenterY = s.y + s.h / 2;

    // Vertical guides (x-axis alignment)
    if (Math.abs(dLeft - sLeft) <= threshold) addV(sLeft);
    if (Math.abs(dLeft - sRight) <= threshold) addV(sRight);
    if (Math.abs(dRight - sLeft) <= threshold) addV(sLeft);
    if (Math.abs(dRight - sRight) <= threshold) addV(sRight);
    if (Math.abs(dCenterX - sCenterX) <= threshold) addV(sCenterX);

    // Horizontal guides (y-axis alignment)
    if (Math.abs(dTop - sTop) <= threshold) addH(sTop);
    if (Math.abs(dTop - sBottom) <= threshold) addH(sBottom);
    if (Math.abs(dBottom - sTop) <= threshold) addH(sTop);
    if (Math.abs(dBottom - sBottom) <= threshold) addH(sBottom);
    if (Math.abs(dCenterY - sCenterY) <= threshold) addH(sCenterY);
  }

  return guides;
}
