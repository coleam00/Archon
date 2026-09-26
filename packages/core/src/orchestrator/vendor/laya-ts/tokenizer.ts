export interface TokenizerLike {
  readonly clsId: number;
  readonly sepId: number;
  readonly maskId: number;
  readonly padId: number;
  readonly maskToken: string;
  encode(text: string): number[];
}

/** Special ids of the laya ModernBERT checkpoint (HF added_tokens). */
export const CHECKPOINT_IDS = {
  cls: 50281,
  sep: 50282,
  mask: 50284,
  pad: 50283,
  unk: 50280,
} as const;

/** Alias lookup order per special: ModernBERT `[X]` names first, Gemma `<x>` names after. */
export const SPECIAL_ALIASES = {
  cls: ['[CLS]', '<bos>', '<s>'],
  sep: ['[SEP]', '<eos>', '</s>'],
  pad: ['[PAD]', '<pad>'],
  mask: ['[MASK]', '<mask>'],
  unk: ['[UNK]', '<unk>'],
} as const;

export interface TokenizerIds {
  cls: number;
  sep: number;
  mask: number;
  pad: number;
  unk: number;
}
export type PreTokenizerKind = 'metaspace' | 'bytelevel';
export interface TokenizerData {
  vocab: Map<string, number>;
  merges: Map<string, number>;
  ids: TokenizerIds;
  kind: PreTokenizerKind;
  maskToken: string;
  /** Normalizer Replace rules (pattern -> content) applied in order before pre-tokenizing. */
  replaces: Array<[string, string]>;
}

/** Metaspace word-boundary marker (HF SentencePiece-style replacement for ' '). */
export const METASPACE_REPLACEMENT = '▁';

/** GPT-2 byte<->unicode table (same mapping as HF ByteLevel pre-tokenizer). */
function byteUnicodeMaps(): { b2u: Map<number, string>; u2b: Map<string, number> } {
  const b2u = new Map<number, string>();
  const u2b = new Map<string, number>();
  const extra = (n: number): number => (n < 0x100 ? n + 0x100 : n);
  const ranges: Array<[number, number]> = [
    [0x21, 0x7e],
    [0xa1, 0xac],
    [0xae, 0xff],
  ];
  let k = 0;
  const inRange = (b: number): boolean => ranges.some(([lo, hi]) => b >= lo && b <= hi);
  for (let b = 0; b < 256; b++) {
    const cp = inRange(b) ? b : extra(k++);
    b2u.set(b, String.fromCodePoint(cp));
    u2b.set(String.fromCodePoint(cp), b);
  }
  return { b2u, u2b };
}

let cached: { b2u: Map<number, string>; u2b: Map<string, number> } | null = null;
function maps(): { b2u: Map<number, string>; u2b: Map<string, number> } {
  if (!cached) cached = byteUnicodeMaps();
  return cached;
}

/** GPT-2 pre-tokenizer split (HF ByteLevel use_regex=true). */
const GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** Piece length at or above which `bpeWord` uses the heap.
 *
 * Its job is to leave the pieces prose is made of on code that did not change. English prose
 * pieces measure a five-byte median with the checkpoint tokenizer (p90 eight, longest eleven),
 * so essentially all of them take the inline rescan below -- byte for byte the loop that
 * shipped before this change, reached in exactly one call as before. That is a regression-proofing choice, not a tuned one.
 *
 * It is deliberately not the break-even point. Per call the two forms cross over nearer six to
 * eight bytes, and swept end to end at 0, 4, 6, 8, 12, 16, 24 and 32 the difference on 8 000
 * characters of English stayed inside +/-5% at every setting -- below what the measurement can
 * resolve. With the threshold in place English provably cannot regress, because it does not
 * reach the new code at all; without it the cost was under 1% and indistinguishable from noise
 * in 200 interleaved rounds. Both are defensible; this one needs no benchmark to believe.
 *
 * What is not noise is what happens past this line, where the rescan is quadratic and the heap
 * is the only form that stays usable.
 */
const HEAP_MIN_LEN = 32;

/** Merge one word's chars greedily by merge rank: lowest rank wins, leftmost breaks a tie.
 *
 * Short pieces take the rescan inlined below, the loop that shipped before this change; long
 * ones take the heap, which is the only form that stays usable when a piece is an entire state.
 * Both forms follow the same rule and return the same tokens -- the tests assert that at every
 * length from 0 to 200 across the boundary.
 *
 * This has to stay near-linear, because the piece reaching it can be an entire state. Both
 * encoders that call it cut only at spaces: `metaspaceEncode` at the metaspace marker and at
 * newline runs, `bpeEncode` on GPT2_SPLIT, whose ` ?\p{L}+` takes a maximal run of letters. A
 * Chinese or Japanese state has no spaces, so it arrives here as one piece -- and this used to
 * rescan the whole word for its best pair and rebuild the array once per merge, which is
 * O(n^2). 8000 unspaced characters cost 1.41 s (Chinese) and 1.60 s (Japanese) through
 * `metaspaceEncode` with mmBERT's tokenizer, against 1.9 ms for English prose of the same
 * length, growing 4x per doubling. Both encoders are synchronous, so that was the whole event
 * loop rather than one slow request.
 *
 * The word is a doubly linked list over the original slots, so merging is a relink rather than
 * an array rebuild, and the candidate pairs live in a binary min-heap keyed on (rank, slot). A
 * slot only ever absorbs the neighbour to its right, so slot indices stay in text order and
 * ordering heap ties by slot index is exactly the leftmost tie-break a left-to-right rescan
 * gets for free.
 *
 * One merge invalidates at most two pairs: the merged slot's own, and the one starting at its
 * left neighbour. Deleting from a heap costs more than re-pushing, so each slot carries a
 * version counter and a popped entry whose version has moved on is skipped -- standard lazy
 * deletion. A matching version is itself proof the pair still has the rank it was pushed with,
 * because `version` moves whenever the slot's text, its right neighbour, or that neighbour's
 * text changes; there is no need to look the rank up again on the way out.
 *
 * Three details are what make this pay rather than merely scale, and together they are worth
 * 1.2-1.3x over the same algorithm written the obvious way. The heap lives in three
 * `Int32Array`s instead of a JS array of tuples, so pushing costs no allocation. Its capacity
 * is derived rather than guessed, so it never grows in practice -- see the note on it below.
 * And both sifts move the hole instead of swapping, one write per level rather than three.
 *
 * Merge *selection* is O(log n), so the call is O(n log n) for the token lengths a learned
 * table produces. `offer` still builds the key `tok[slot] + " " + tok[j]`, which costs the
 * length of those tokens, so a contrived table that grows a single token to O(n) stays
 * quadratic in key construction alone -- measured on such a table it grows 4x or worse per
 * doubling and is only 2.8-3.9x faster than the rescan. Real tables cap token length far below
 * n, which is why the checkpoint tokenizers measure linear here.
 */
function bpeWord(chars: string[], rank: Map<string, number>): string[] {
  if (chars.length >= HEAP_MIN_LEN) return bpeWordHeap(chars, rank);
  // The rescan stays inline rather than in its own function, so a short piece costs exactly one
  // call as it did before -- routing it through a helper added a second call frame, and at ~10 ns
  // over the 2 824 pieces in 8 000 characters of English prose that measured as a real 0.8%.
  let word = chars.slice();
  if (word.length <= 1) return word;
  for (;;) {
    let best = Infinity,
      idx = -1;
    for (let i = 0; i < word.length - 1; i++) {
      const r = rank.get(word[i] + ' ' + word[i + 1]);
      if (r !== undefined && r < best) {
        best = r;
        idx = i;
      }
    }
    if (idx < 0) return word;
    word = [...word.slice(0, idx), word[idx] + word[idx + 1], ...word.slice(idx + 2)];
  }
}

/** The same rule in O(n log n): pairs chosen from a min-heap over a linked list of the slots. */
function bpeWordHeap(chars: string[], rank: Map<string, number>): string[] {
  const n = chars.length;
  const tok = chars.slice();
  if (n <= 1) return tok;

  const next = new Int32Array(n),
    prev = new Int32Array(n);
  const version = new Int32Array(n);
  const dead = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1 < n ? i + 1 : -1;
  }

  // 3n is a bound, not a hope: at most n-1 pairs are offered up front, every merge kills exactly
  // one slot so there are at most n-1 merges, and each offers at most two pairs -- 3n-3 pushes
  // worst case. Measured over 120 000 inputs, including tables built to maximise pushes, the
  // high-water mark is 2n. The grow below still exists because an out-of-bounds typed-array
  // write is silently dropped in JS, which would cost a merge and emit wrong tokens with no
  // error at all: too quiet a failure to leave resting on a proof. It costs under 1%.
  let heapCap = 3 * n;
  let heapRank = new Int32Array(heapCap),
    heapSlot = new Int32Array(heapCap),
    heapVer = new Int32Array(heapCap);
  let heapLen = 0;

  /** Offer the pair starting at `slot`, when it has a right neighbour and a rank. Sifts up by
   *  moving the hole down toward the root, writing the new entry once at the end. */
  const offer = (slot: number): void => {
    const j = next[slot];
    if (j < 0) return;
    const r = rank.get(tok[slot] + ' ' + tok[j]);
    if (r === undefined) return;
    if (heapLen === heapCap) {
      heapCap *= 2;
      const r2 = new Int32Array(heapCap);
      r2.set(heapRank);
      heapRank = r2;
      const s2 = new Int32Array(heapCap);
      s2.set(heapSlot);
      heapSlot = s2;
      const v2 = new Int32Array(heapCap);
      v2.set(heapVer);
      heapVer = v2;
    }
    const ver = version[slot];
    let c = heapLen++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapRank[p] < r || (heapRank[p] === r && heapSlot[p] < slot)) break;
      heapRank[c] = heapRank[p];
      heapSlot[c] = heapSlot[p];
      heapVer[c] = heapVer[p];
      c = p;
    }
    heapRank[c] = r;
    heapSlot[c] = slot;
    heapVer[c] = ver;
  };

  for (let i = 0; i < n - 1; i++) offer(i);

  while (heapLen > 0) {
    const slot = heapSlot[0],
      ver = heapVer[0];

    // Pop: take the last entry and sift it down through the hole left at the root.
    const lastRank = heapRank[--heapLen],
      lastSlot = heapSlot[heapLen],
      lastVer = heapVer[heapLen];
    if (heapLen > 0) {
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        if (l >= heapLen) break;
        const r = l + 1;
        let m = l;
        if (
          r < heapLen &&
          (heapRank[r] < heapRank[l] || (heapRank[r] === heapRank[l] && heapSlot[r] < heapSlot[l]))
        )
          m = r;
        if (heapRank[m] > lastRank || (heapRank[m] === lastRank && heapSlot[m] > lastSlot)) break;
        heapRank[c] = heapRank[m];
        heapSlot[c] = heapSlot[m];
        heapVer[c] = heapVer[m];
        c = m;
      }
      heapRank[c] = lastRank;
      heapSlot[c] = lastSlot;
      heapVer[c] = lastVer;
    }

    if (dead[slot] || version[slot] !== ver) continue; // superseded by a later merge
    const j = next[slot];
    if (j < 0 || dead[j]) continue;

    tok[slot] = tok[slot] + tok[j];
    dead[j] = 1;
    const k = next[j];
    next[slot] = k;
    if (k >= 0) prev[k] = slot;

    version[slot]++;
    offer(slot);
    const p = prev[slot];
    if (p >= 0) {
      version[p]++;
      offer(p);
    }
  }

  const out: string[] = [];
  for (let i = 0; i >= 0; i = next[i]) out.push(tok[i]);
  return out;
}

/** Byte-level BPE encode: NFC-normalize, NO lowercasing, GPT-2 byte map + rank-order merges. */
let sharedEncoder: TextEncoder | null = null;
export function bpeEncode(
  vocab: Map<string, number>,
  merges: Map<string, number>,
  text: string
): number[] {
  const { b2u } = maps();
  const unkId = vocab.get('[UNK]') ?? CHECKPOINT_IDS.unk;
  const out: number[] = [];
  const enc = (sharedEncoder ??= new TextEncoder());
  const parts = text.normalize('NFC').match(GPT2_SPLIT);
  if (!parts) return out;
  for (const piece of parts) {
    const chars: string[] = [];
    for (const b of enc.encode(piece)) chars.push(b2u.get(b) ?? '');
    for (const tok of bpeWord(chars, merges)) out.push(vocab.get(tok) ?? unkId);
  }
  return out;
}

/** Metaspace (SentencePiece-style) BPE encode: unicode chars, NO byte map, NO lowercasing.
 * Normalizer replaces run first, then one marker is ensured at text start, then the text
 * is cut into words at each marker (marker kept as word prefix) with maximal `\n` runs
 * as their own pieces. Each piece is BPE-merged; leftover unknown pieces map to unk. */
export function metaspaceEncode(
  vocab: Map<string, number>,
  merges: Map<string, number>,
  text: string,
  unkId?: number,
  replaces: ReadonlyArray<readonly [string, string]> = [[' ', METASPACE_REPLACEMENT]]
): number[] {
  const unk = unkId ?? vocab.get('<unk>') ?? vocab.get('[UNK]') ?? CHECKPOINT_IDS.unk;
  if (!text) return [];
  let t = text;
  for (const [from, to] of replaces) t = t.split(from).join(to);
  const out: number[] = [];
  const push = (piece: string): void => {
    for (const tok of bpeWord(Array.from(piece), merges)) out.push(vocab.get(tok) ?? unk);
  };
  for (const seg of t.split(/(\n+)/)) {
    if (!seg) continue;
    if (seg[0] === '\n') {
      push(seg);
    } else {
      const w = seg.startsWith(METASPACE_REPLACEMENT) ? seg : METASPACE_REPLACEMENT + seg;
      for (const chunk of w.split(METASPACE_REPLACEMENT).slice(1)) {
        push(chunk ? METASPACE_REPLACEMENT + chunk : METASPACE_REPLACEMENT);
      }
    }
  }
  return out;
}

/** Dispatch to the Metaspace or GPT-2/ByteLevel encoder based on the parsed pre-tokenizer. */
export function encodeWithData(data: TokenizerData, text: string): number[] {
  return data.kind === 'metaspace'
    ? metaspaceEncode(data.vocab, data.merges, text, data.ids.unk, data.replaces)
    : bpeEncode(data.vocab, data.merges, text);
}

function childNodes(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const o = node as Record<string, unknown>;
  const out: unknown[] = [];
  for (const k of ['normalizers', 'pre_tokenizers', 'decoders']) {
    const v = o[k];
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

/** True when a normalizer/pre-tokenizer/decoder node (or nested Sequence member) has a type. */
function hasNodeType(node: unknown, want: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if ((node as Record<string, unknown>)['type'] === want) return true;
  return childNodes(node).some(c => hasNodeType(c, want));
}

/** Collect normalizer Replace rules ({pattern: {String}, content}) in order. */
function collectReplaces(node: unknown, out: Array<[string, string]>): void {
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o['type'] === 'Replace') {
    const pat = o['pattern'] as Record<string, unknown> | undefined;
    const from = pat?.['String'];
    const to = o['content'];
    if (typeof from === 'string' && typeof to === 'string') out.push([from, to]);
  }
  for (const c of childNodes(node)) collectReplaces(c, out);
}

/** Parse an HF tokenizer.json ({model vocab/merges, normalizer, pre_tokenizer, added_tokens}). */
export function parseTokenizerJson(raw: unknown): TokenizerData | null {
  try {
    const r = raw as {
      model?: { vocab?: Record<string, number>; merges?: Array<string | [string, string]> };
      normalizer?: unknown;
      pre_tokenizer?: unknown;
      added_tokens?: Array<{ id?: number; content?: string }>;
    };
    const vocabObj = r?.model?.vocab;
    if (!vocabObj || typeof vocabObj !== 'object') return null;
    const vocab = new Map(Object.entries(vocabObj));
    const merges = new Map<string, number>();
    for (const [i, m] of (r.model?.merges ?? []).entries()) {
      const pair = typeof m === 'string' ? m.split(' ') : m;
      if (pair.length >= 2) merges.set(pair[0] + ' ' + pair[1], i);
    }
    const added = new Map<string, number>();
    for (const t of r.added_tokens ?? []) {
      if (typeof t?.content === 'string' && typeof t?.id === 'number') added.set(t.content, t.id);
    }
    const pick = (aliases: readonly string[], fb: number): { id: number; token: string } => {
      for (const a of aliases) {
        const v = added.get(a) ?? vocab.get(a);
        if (v !== undefined) return { id: v, token: a };
      }
      return { id: fb, token: aliases[0] };
    };
    const cls = pick(SPECIAL_ALIASES.cls, CHECKPOINT_IDS.cls);
    const sep = pick(SPECIAL_ALIASES.sep, CHECKPOINT_IDS.sep);
    const mask = pick(SPECIAL_ALIASES.mask, CHECKPOINT_IDS.mask);
    const pad = pick(SPECIAL_ALIASES.pad, CHECKPOINT_IDS.pad);
    const unk = pick(SPECIAL_ALIASES.unk, CHECKPOINT_IDS.unk);
    const kind: PreTokenizerKind = hasNodeType(r?.pre_tokenizer, 'Metaspace')
      ? 'metaspace'
      : 'bytelevel';
    const replaces: Array<[string, string]> = [];
    collectReplaces(r?.normalizer, replaces);
    if (kind === 'metaspace' && replaces.length === 0) replaces.push([' ', METASPACE_REPLACEMENT]);
    return {
      vocab,
      merges,
      ids: { cls: cls.id, sep: sep.id, mask: mask.id, pad: pad.id, unk: unk.id },
      kind,
      maskToken: mask.token,
      replaces,
    };
  } catch {
    return null;
  }
}

/** Load tokenizer.json from a local file into vocab/merges/ids. */
export async function loadTokenizerJson(filePath: string): Promise<TokenizerData | null> {
  const path: typeof import('node:path') = await import('node:path');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) {
    throw new Error('A local tokenizer file path is required');
  }
  const fs: typeof import('node:fs/promises') = await import('node:fs/promises');
  const raw = JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
  return parseTokenizerJson(raw);
}
