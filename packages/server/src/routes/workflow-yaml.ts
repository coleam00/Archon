/**
 * Serialize a workflow definition for saving while keeping the authored YAML text.
 *
 * The builder sends the whole definition on every save. Re-serializing it from scratch drops
 * every comment and reflows the file, so instead the new definition is merged into the parsed
 * document of the file already on disk, which keeps comments and scalar styles.
 *
 * The library still re-renders whitespace (`{ a }` becomes `{a}`), so the merged document is
 * not written as is: the old and the merged document are both rendered, their line diff is
 * exactly the edit, and that edit is laid over the original text. Lines the edit does not
 * touch come from the file on disk byte for byte.
 */
import { Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Node } from 'yaml';

type Plain = Record<string, unknown>;

/**
 * `[a, b]` rather than the library default `[ a, b ]`, and no folding of long lines — the form
 * the workflow files are written in.
 */
const TO_STRING = { flowCollectionPadding: false, lineWidth: 0 } as const;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Id of a sequence item that is a mapping with a string `id` (a DAG node), else undefined. */
function itemId(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.id === 'string' ? value.id : undefined;
}

/** Merge `value` into `node` in place when the shapes match; return the node to keep. */
function merge(doc: Document, node: unknown, value: unknown): Node {
  // The definition arrives as JSON, so an alias comes back as a copy of its anchor's value. While
  // the copy still equals the anchored node (already merged: anchors precede their aliases), the
  // alias stays; once it differs, the alias is replaced by its own value.
  if (isAlias(node)) {
    const target = node.resolve(doc);
    if (target && Bun.deepEquals(target.toJS(doc), value)) return node;
    return doc.createNode(value);
  }

  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    if (node.value === value) return node;
    // Same scalar kind keeps the node, and with it its comments and quoting style.
    if (typeof node.value === typeof value) {
      node.value = value;
      return node;
    }
    return doc.createNode(value);
  }

  if (isMap(node) && isPlainObject(value)) {
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof key !== 'string' || !(key in value) || value[key] === undefined) {
        node.delete(pair.key);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      node.set(key, merge(doc, node.get(key, true), child));
    }
    return node;
  }

  if (isSeq(node) && Array.isArray(value)) {
    const oldItems = node.items;
    const byId = new Map<string, unknown>();
    for (const item of oldItems) {
      const id = isMap(item) ? item.get('id') : undefined;
      if (typeof id === 'string') byId.set(id, item);
    }
    // DAG nodes are matched by id, so reordering or removing one keeps the others' comments.
    node.items = value.map((child, index) => {
      const id = itemId(child);
      const previous = id !== undefined ? byId.get(id) : oldItems[index];
      return merge(doc, previous, child);
    });
    // The library attaches the comment above the first item to the sequence itself; when that
    // item moves, its comment goes with it.
    const first = oldItems[0];
    if (
      node.commentBefore &&
      isNode(first) &&
      node.items[0] !== first &&
      node.items.includes(first)
    ) {
      first.commentBefore = [node.commentBefore, first.commentBefore].filter(Boolean).join('\n');
      node.commentBefore = undefined;
    }
    return node;
  }

  return doc.createNode(value);
}

/**
 * After a merge that reordered nodes, an alias can precede its anchor, which YAML forbids.
 * Such an alias is written out as the value it stood for.
 */
function settleAliases(doc: Document): void {
  // Collected up front: Alias.resolve() only finds anchors above the alias.
  const anchored = new Map<string, Node>();
  visit(doc, {
    Node(_key, node) {
      if (node.anchor) anchored.set(node.anchor, node);
      return undefined;
    },
  });
  const anchorsSeen = new Set<string>();
  visit(doc, {
    Alias(_key, alias) {
      if (anchorsSeen.has(alias.source)) return undefined;
      const target = anchored.get(alias.source);
      // A kept alias always has a target: merge() replaces those whose anchor is gone.
      return target ? doc.createNode(target.toJS(doc)) : undefined;
    },
    Node(_key, node) {
      if (node.anchor) anchorsSeen.add(node.anchor);
      return undefined;
    },
  });
}

/**
 * Longest-common-subsequence match of two line lists: for each line of `a`, the index of the
 * line of `b` it is matched to, or -1. Matched indices increase with the index into `a`.
 */
function matchLines(a: string[], b: string[]): number[] {
  // ceiling: O(n*m) table, fine for workflow files of hundreds of lines; Myers diff if they grow
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const match = new Array<number>(a.length).fill(-1);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) match[i++] = j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return match;
}

/**
 * Lay the edit `rendered` → `edited` over `original`, where `rendered` is `original` re-rendered
 * by the library. `rendered` is cut into segments by its lines that appear verbatim in
 * `original`: such a line is a segment of its own, and each run of re-rendered lines between two
 * of them is one segment paired with the original lines it replaced. A segment the edit leaves
 * alone is written as the original lines; a segment it touches is written as the edited lines.
 */
function overlayEdit(original: string[], rendered: string[], edited: string[]): string[] {
  const toOriginal = matchLines(rendered, original);
  const toEdited = matchLines(rendered, edited);

  interface Segment {
    originalLines: string[];
    editedLines: string[];
    touched: boolean;
    /** Lines the edit inserts right after this segment, between it and the next one. */
    inserted: string[];
  }
  const segment = (originalLines: string[]): Segment => ({
    originalLines,
    editedLines: [],
    touched: false,
    inserted: [],
  });
  const leading = segment([]);
  const segments: Segment[] = [leading];
  const segmentOf: Segment[] = [];
  let originalAt = 0;
  for (let i = 0; i < rendered.length; i++) {
    const inOriginal = toOriginal[i];
    if (inOriginal >= 0) {
      // Original lines the re-render dropped (between two verbatim lines) stay as they were.
      const dropped = original.slice(originalAt, inOriginal);
      if (dropped.length > 0) segments.push(segment(dropped));
      segments.push(segment([original[inOriginal]]));
      originalAt = inOriginal + 1;
    } else if (i === 0 || toOriginal[i - 1] >= 0) {
      let end = i;
      while (end < rendered.length && toOriginal[end] < 0) end++;
      const nextOriginal = end < rendered.length ? toOriginal[end] : original.length;
      segments.push(segment(original.slice(originalAt, nextOriginal)));
      originalAt = nextOriginal;
    }
    segmentOf.push(segments[segments.length - 1]);
  }
  if (originalAt < original.length) segments.push(segment(original.slice(originalAt)));

  // Walk the rendered → edited diff. A line inserted between two segments stands on its own;
  // one inserted inside a multi-line segment makes that segment touched.
  let editedAt = 0;
  for (let i = 0; i <= rendered.length; i++) {
    const inEdited = i < rendered.length ? toEdited[i] : edited.length;
    if (inEdited < 0) {
      segmentOf[i].touched = true;
      continue;
    }
    if (inEdited > editedAt) {
      const lines = edited.slice(editedAt, inEdited);
      const before = i === 0 ? leading : segmentOf[i - 1];
      if (i === rendered.length || segmentOf[i] !== before) {
        before.inserted.push(...lines);
      } else {
        before.editedLines.push(...lines);
        before.touched = true;
      }
    }
    if (i < rendered.length) segmentOf[i].editedLines.push(edited[inEdited]);
    editedAt = inEdited + 1;
  }

  return segments.flatMap(s => [...(s.touched ? s.editedLines : s.originalLines), ...s.inserted]);
}

/**
 * Return the YAML text to write for `definition`.
 * `existingText` is the current file content, or undefined when the workflow is new.
 */
export function serializeWorkflowPreservingText(
  definition: Record<string, unknown>,
  existingText: string | undefined
): string {
  if (existingText !== undefined) {
    // Work in LF: the library keeps a CR inside comments of a CRLF file, which would make those
    // rendered lines differ from the original ones. The file's line ending is restored at the end.
    const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
    const text = existingText.replace(/\r\n/g, '\n');
    // Widened from Document.Parsed: merged-in nodes are created, not parsed.
    const doc: Document = parseDocument(text);
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      if (Bun.deepEquals(doc.toJS(), definition)) return existingText;
      const rendered = doc.toString(TO_STRING);
      doc.contents = merge(doc, doc.contents, definition);
      settleAliases(doc);
      const edited = doc.toString(TO_STRING);
      return overlayEdit(text.split('\n'), rendered.split('\n'), edited.split('\n')).join(eol);
    }
    // An unparseable file on disk has no text worth keeping; the save replaces it.
  }
  return new Document(definition).toString(TO_STRING);
}
