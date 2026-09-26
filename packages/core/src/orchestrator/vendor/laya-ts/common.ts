import type { TokenizerLike } from './tokenizer.js';
export type QType = 'choice' | 'score' | 'noul';
export interface InternalQ {
  t: QType;
  ins: string;
  crit: unknown;
  labels?: { false: string; true: string };
}
/** Python `json.dumps` for a finite number. JavaScript prints the same shortest round-trip
digits, but Python switches to exponent notation below 1e-4 (JavaScript: below 1e-6) and pads the
exponent to two digits (`5e-05`, not `5e-5`). An integer-valued number prints as before, which
matches a Python int below 1e21: JavaScript cannot tell Python's `49.0` from `49`. */
function pyNumber(v: number): string {
  const [mant, exp] = v.toExponential().split('e');
  const e = Number(exp);
  return e >= -4 ? String(v) : `${mant}e-${String(-e).padStart(2, '0')}`;
}
/** Python `json.dumps(v, ensure_ascii=False)` replica: separators (", ", ": "),
unicode raw, unknown types fall back to undefined (caller applies str()). */
function pyJson(v: unknown): string | undefined {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return pyNumber(v);
  }
  if (Array.isArray(v)) return `[${v.map(x => pyJson(x) ?? 'null').join(', ')}]`;
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const s = pyJson(x);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}: ${s}`);
    }
    return `{${parts.join(', ')}}`;
  }
  return undefined;
}
export function serializeState(state: unknown): string {
  if (typeof state === 'string') return state;
  return pyJson(state) ?? String(state);
}
function renderCriterion(v: unknown): string {
  return typeof v === 'string' ? v : (pyJson(v) ?? String(v));
}
export function renderOptions(q: InternalQ): string[] {
  if (q.t === 'choice') {
    const crit = q.crit as Record<string, unknown>;
    return Object.entries(crit).map(([k, v]) =>
      v === null || v === undefined || v === '' ? k : `${k}: ${renderCriterion(v)}`
    );
  }
  if (q.t === 'score') {
    return (q.crit as unknown[]).map((c, i) => `level ${i}: ${renderCriterion(c)}`);
  }
  const crit = (q.crit ?? {}) as Record<string, unknown>;
  const labels = q.labels ?? { false: 'false', true: 'true' };
  const f = crit['false'],
    t = crit['true'];
  return [
    labels.false +
      ': ' +
      (f !== null && f !== undefined && f !== ''
        ? renderCriterion(f)
        : 'no, the statement does not hold'),
    labels.true +
      ': ' +
      (t !== null && t !== undefined && t !== '' ? renderCriterion(t) : 'yes, the statement holds'),
  ];
}
export interface QuestionPrefix {
  /** [CLS] head [SEP] options [SEP] — the state-independent part of the sequence. */
  ids: number[];
  /** Mask-marker positions (absolute; the prefix sits at the start of the final sequence). */
  markers: number[];
  nOptions: number;
}
/** The question half of `buildSequence`: everything before the state tokens. Hoisted out so
 * callers asking several questions about the same state can encode the state text only once. */
export function buildQuestionPrefix(
  tok: TokenizerLike,
  q: InternalQ,
  _maxLen = 512,
  headMaxLen = 192,
  optionOrder?: number[]
): QuestionPrefix {
  const maskTok = tok.maskToken;
  const opts = renderOptions(q);
  const order = optionOrder ?? opts.map((_, i) => i);
  const ins = String(q.ins).split(maskTok).join(' ');
  let headIds = tok.encode(`${q.t} question: ${ins}`);
  let optIds = order.map(i => [
    tok.maskId,
    ...tok.encode(' ' + opts[i].split(maskTok).join(' ')).slice(0, 48),
  ]);
  let budget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  if (budget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map(o => o.slice(0, per));
    budget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  }
  headIds = headIds.slice(0, Math.max(8, budget));
  const ids = [tok.clsId, ...headIds, tok.sepId];
  const markers: number[] = [];
  for (const o of optIds) {
    markers.push(ids.length);
    ids.push(...o);
  }
  ids.push(tok.sepId);
  return { ids, markers, nOptions: opts.length };
}
/** Append pre-encoded state tokens to a question prefix. Identical output to building the
 * whole sequence in one pass, but the state only needs encoding once per state, not once
 * per (state, question) pair. */
export function sequenceWithState(
  prefix: QuestionPrefix,
  stateIds: number[],
  sepId: number,
  maxLen = 512,
  truncateLeft = false
): { ids: number[]; markers: number[] } {
  const room = Math.max(0, maxLen - prefix.ids.length - 1);
  // not stateIds.slice(-room): with no room left, slice(-0) is the whole state rather than none of it
  const st = truncateLeft
    ? stateIds.slice(Math.max(0, stateIds.length - room))
    : stateIds.slice(0, room);
  const ids = [...prefix.ids, ...st, sepId].slice(0, maxLen);
  return { ids, markers: prefix.markers.filter(m => m < maxLen) };
}
export function buildSequence(
  tok: TokenizerLike,
  state: unknown,
  q: InternalQ,
  maxLen = 512,
  headMaxLen = 192,
  optionOrder?: number[],
  truncateLeft = false
): { ids: number[]; markers: number[] } {
  const stAll = tok.encode(serializeState(state).split(tok.maskToken).join(' '));
  return sequenceWithState(
    buildQuestionPrefix(tok, q, maxLen, headMaxLen, optionOrder),
    stAll,
    tok.sepId,
    maxLen,
    truncateLeft
  );
}
export function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map(v => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}
export function confidenceFromProbs(p: number[]): number {
  const k = p.length;
  if (k < 2) return 1.0;
  const ent = -p.reduce((a, v) => a + v * Math.log(Math.max(v, 1e-12)), 0);
  return Math.min(1, Math.max(0, 1 - ent / Math.log(k)));
}
export function answerConfidence(p: number[]): number {
  // Probability mass on the reported answer: max(p). This is the quantity temperature
  // scaling fits and the one every calibration figure is computed on, so it is stable
  // across option counts and comparable across question types -- unlike
  // confidenceFromProbs, whose entropy scale moves with k.
  if (p.length < 1) return 1.0;
  return Math.min(1, Math.max(0, Math.max(...p)));
}
export const TEMP_MIN = 0.5,
  TEMP_MAX = 5.0;
export function clampTemperature(t: unknown): number {
  if (t === null || t === undefined || t === '' || typeof t === 'boolean') return 1.0;
  const f = typeof t === 'number' ? t : Number(t);
  if (!Number.isFinite(f)) return 1.0;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, f));
}
export function tempBucket(qtype: number, k: number): string {
  const size = k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+';
  return `${['choice', 'score', 'noul'][qtype]}:${size}`;
}
/** Max of a length list without spread (Math.max(...arr) throws RangeError past ~100k args). */
export function maxOf(values: ArrayLike<number>, fallback = 0): number {
  let m = fallback;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}
export interface CollateItem {
  ids: number[];
  markers: number[];
  qtype: number;
  label?: number;
  target?: number[];
  [k: string]: unknown;
}
export interface CollatedBatch {
  inputIds: number[][];
  attentionMask: number[][];
  markerPos: number[][];
  markerMask: boolean[][];
  qtype: number[];
  label: number[];
  meta: Record<string, unknown>[];
  target?: number[][];
}
/** TS parity of py `collate_items(batch, pad_id)`: batch = list of groups. */
export function collateItems(batch: CollateItem[][], padId: number): CollatedBatch | null {
  const items = (batch ?? []).flat();
  if (items.length === 0) return null;
  let L = 0;
  let K = 0;
  for (const it of items) {
    if (it.ids.length > L) L = it.ids.length;
    if (it.markers.length > K) K = it.markers.length;
  }
  const hasTarget = items.some(it => 'target' in it);
  const inputIds = items.map(it => [...it.ids, ...Array(L - it.ids.length).fill(padId)]);
  const attentionMask = items.map(it => [
    ...Array(it.ids.length).fill(1),
    ...Array(L - it.ids.length).fill(0),
  ]);
  const markerPos = items.map(it => [...it.markers, ...Array(K - it.markers.length).fill(0)]);
  const markerMask = items.map(it => [
    ...it.markers.map(() => true),
    ...Array(K - it.markers.length).fill(false),
  ]);
  const qtype = items.map(it => it.qtype);
  const label = items.map(it => (typeof it.label === 'number' ? it.label : -1));
  const meta = items.map(it => {
    const { ids: _ids, markers: _markers, target: _target, ...m } = it;
    return m;
  });
  const out: CollatedBatch = { inputIds, attentionMask, markerPos, markerMask, qtype, label, meta };
  if (hasTarget) {
    out.target = items.map((it, i) => {
      const t = Array.isArray(it.target) ? (it.target as number[]) : [];
      const k = it.markers.length;
      if (t.length > k) {
        // Same guard as py collate_items: the limit is this item's own marker count, not the
        // batch-wide K — a wider sibling row must not legitimise extra entries (#311).
        throw new Error(
          `collateItems: item ${i} has ${t.length} target entries but only ${k} marker positions; ` +
            'a target needs one entry per option'
        );
      }
      return [...t, ...Array(K - t.length).fill(0)];
    });
  }
  return out;
}
