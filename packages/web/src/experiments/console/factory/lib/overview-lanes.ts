/**
 * How the factory overview routes a view's `loops-back` edges, the lines that send work back,
 * in world px. The console's only copy of these rules: the engine keeps no How it works schema.
 *
 * - A **reply** is a `loops-back` edge A->B in a view that has a `calls` edge B->A: the answer
 *   to an ask. It runs straight beside that ask, the ask shifted one way and the reply the
 *   other, so the pair reads as a question and its answer.
 * - Every other `loops-back` edge is a **lane line**. It drops from a port on the bottom of its
 *   source card into the lane under every box of the view, runs along its own track there, and
 *   rises into a port on the bottom of its target card.
 *
 * A card's bottom holds one port per lane line ending there. Its ports take, left to right,
 * the lines whose other end is to the left, nearest other end first, then those whose other
 * end is to the right, farthest first. A line's track is its depth: 0 when its span (port to
 * port) holds no other lane line, else one deeper than the deepest line it holds. Two lines
 * whose spans are nested or apart then never meet; two whose spans interleave must cross,
 * and do (the crossing check refuses them).
 */

/** Which edges of a view take part in a reply: the replies, and the `calls` edges they answer. */
export function replies(edges: readonly { from: string; to: string; kind: string }[]): {
  replies: Set<number>;
  answered: Set<number>;
} {
  const out = { replies: new Set<number>(), answered: new Set<number>() };
  edges.forEach((edge, index) => {
    if (edge.kind !== 'loops-back') return;
    const asked = edges.findIndex(
      other => other.kind === 'calls' && other.from === edge.to && other.to === edge.from
    );
    if (asked < 0) return;
    out.replies.add(index);
    out.answered.add(asked);
  });
  return out;
}

/** A card a lane line joins: its id, its column, and its box's left, width and bottom. */
export interface LaneEnd {
  id: string;
  col: number;
  left: number;
  width: number;
  bottom: number;
}

export interface LaneLine {
  /** The edge's index in its view, which breaks ties between ports. */
  index: number;
  from: LaneEnd;
  to: LaneEnd;
}

/** A routed lane line: four points from its source to its target, and its track's depth. */
export interface LaneRoute {
  points: { x: number; y: number }[];
  depth: number;
}

/** Each line's port x at each end, by the port order above. */
function portsOf(lines: readonly LaneLine[]): Map<LaneLine, { from: number; to: number }> {
  const atCard = new Map<
    string,
    { card: LaneEnd; ends: { line: LaneLine; other: LaneEnd; end: 'from' | 'to' }[] }
  >();
  for (const line of lines)
    for (const [end, card, other] of [
      ['from', line.from, line.to],
      ['to', line.to, line.from],
    ] as const) {
      const at = atCard.get(card.id) ?? { card, ends: [] };
      at.ends.push({ line, other, end });
      atCard.set(card.id, at);
    }
  const ports = new Map<LaneLine, { from: number; to: number }>();
  for (const { card, ends: list } of atCard.values()) {
    const side = (other: LaneEnd): number => (other.col < card.col ? 0 : 1);
    list.sort(
      (a, b) =>
        side(a.other) - side(b.other) || b.other.col - a.other.col || a.line.index - b.line.index
    );
    list.forEach(({ line, end }, i) => {
      const port = ports.get(line) ?? { from: 0, to: 0 };
      port[end] = card.left + (card.width * (i + 1)) / (list.length + 1);
      ports.set(line, port);
    });
  }
  return ports;
}

/**
 * Every lane line's route, by index. `laneTop` is the first track, under every box of the
 * view; each deeper track is `track` further down. Lines must join cards in different columns;
 * the caller refuses the others before routing.
 */
export function laneRoutes(
  lines: readonly LaneLine[],
  laneTop: number,
  track: number
): Map<number, LaneRoute> {
  const ports = portsOf(lines);
  const spans = lines.map(line => {
    const port = ports.get(line) as { from: number; to: number };
    return { line, port, lo: Math.min(port.from, port.to), hi: Math.max(port.from, port.to) };
  });
  // A line holds only narrower lines, so narrowest first gives each its depth after theirs.
  spans.sort((a, b) => a.hi - a.lo - (b.hi - b.lo));
  const depths: number[] = [];
  const routes = new Map<number, LaneRoute>();
  spans.forEach((span, i) => {
    const held = spans
      .slice(0, i)
      .map((inner, j) => (span.lo < inner.lo && inner.hi < span.hi ? (depths[j] as number) : -1));
    const depth = Math.max(-1, ...held) + 1;
    depths.push(depth);
    const y = laneTop + depth * track;
    const { from, to } = span.port;
    routes.set(span.line.index, {
      depth,
      points: [
        { x: from, y: span.line.from.bottom },
        { x: from, y },
        { x: to, y },
        { x: to, y: span.line.to.bottom },
      ],
    });
  });
  return routes;
}
