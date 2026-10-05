/**
 * Serialize a workflow definition for saving while keeping the authored YAML text.
 *
 * The builder sends the whole definition on every save. Re-serializing it from scratch drops
 * every comment and reflows the file, so instead the new definition is merged into the parsed
 * document of the file already on disk, which keeps comments and scalar styles.
 *
 * The library re-renders whitespace (`{ a }` becomes `{a}`); that is the accepted cost of keeping
 * this small. Before the text is returned it is parsed back and compared with the definition, so
 * a merge that produced a different document fails the save instead of being written.
 */
import {
  Document,
  Scalar,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from 'yaml';
import type { Alias, Node } from 'yaml';

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

function isBlockScalar(node: Scalar): boolean {
  return node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
}

interface MergeState {
  doc: Document;
  /** The value each kept alias stands for, for settleAliases to write out if it must. */
  aliasValues: Map<Alias, unknown>;
}

/** Merge `value` into `node` in place when the shapes match; return the node to keep. */
function merge(state: MergeState, node: unknown, value: unknown): Node {
  const { doc } = state;
  // The definition arrives as JSON, so an alias comes back as a copy of its anchor's value. While
  // the copy still equals the anchored node, the alias stays; once it differs, the alias is
  // replaced by its own value.
  if (isAlias(node)) {
    const target = node.resolve(doc);
    if (target && Bun.deepEquals(target.toJS(doc), value)) {
      state.aliasValues.set(node, value);
      return node;
    }
    return doc.createNode(value);
  }

  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    if (node.value === value) return node;
    // Same scalar kind keeps the node, and with it its comments and quoting style.
    if (typeof node.value === typeof value) {
      node.value = value;
      // A quoted or plain scalar spells a line break as a blank line, which Bun's parser reads
      // as two in a CRLF file. A literal block reads the same under both line endings.
      if (typeof value === 'string' && value.includes('\n') && !isBlockScalar(node)) {
        node.type = Scalar.BLOCK_LITERAL;
      }
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
      node.set(key, merge(state, node.get(key, true), child));
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
    // An old item is merged into once: a second item that maps to it (a duplicate id) is
    // written as a new node, so the file says what was sent and validation can name the fault.
    const claimed = new Set<unknown>();
    node.items = value.map((child, index) => {
      const id = itemId(child);
      const candidate = id !== undefined ? byId.get(id) : oldItems[index];
      const previous = claimed.has(candidate) ? undefined : candidate;
      claimed.add(candidate);
      return merge(state, previous, child);
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
 * An alias kept by merge() stays only while its anchor is above it and still holds the value
 * the alias stood for; otherwise it is written out as that value. This runs after the whole
 * merge because merge() visits in the definition's order, not the file's: the anchor can be
 * edited, moved below the alias, or removed after the alias was kept.
 */
function settleAliases({ doc, aliasValues }: MergeState): void {
  const anchorsSeen = new Set<string>();
  visit(doc, {
    Alias(_key, alias) {
      const value = aliasValues.get(alias);
      if (anchorsSeen.has(alias.source)) {
        const target = alias.resolve(doc);
        if (target && Bun.deepEquals(target.toJS(doc), value)) return undefined;
      }
      return doc.createNode(value);
    },
    Node(_key, node) {
      if (node.anchor) anchorsSeen.add(node.anchor);
      return undefined;
    },
  });
}

/** The text a save was about to write does not parse back to the definition that was sent. */
export class WorkflowReadBackError extends Error {
  constructor() {
    super('Serialized workflow does not read back as the submitted definition');
    this.name = 'WorkflowReadBackError';
  }
}

/**
 * Whether `text` parses to `definition`. Parsed with the parser the workflow loader uses, so
 * the comparison is against what a read of the file sees.
 */
function readsAs(text: string, definition: Record<string, unknown>): boolean {
  let read: unknown;
  try {
    read = Bun.YAML.parse(text);
  } catch {
    return false;
  }
  return Bun.deepEquals(read, definition);
}

/** Throw unless `text` parses to `definition`. */
export function assertReadsBackAs(text: string, definition: Record<string, unknown>): void {
  if (!readsAs(text, definition)) throw new WorkflowReadBackError();
}

/**
 * Return the YAML text to write for `definition`.
 * `existingText` is the current file content, or undefined when the workflow is new.
 * Throws WorkflowReadBackError when the text would not read back as `definition`.
 */
export function serializeWorkflowPreservingText(
  definition: Record<string, unknown>,
  existingText: string | undefined
): string {
  const text = render(definition, existingText);
  assertReadsBackAs(text, definition);
  return text;
}

function render(definition: Record<string, unknown>, existingText: string | undefined): string {
  if (existingText !== undefined) {
    // Work in LF: the library keeps a CR inside comments of a CRLF file and ends lines with LF,
    // which would mix the two. The file's line ending is restored at the end.
    const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
    // Widened from Document.Parsed: merged-in nodes are created, not parsed.
    const doc: Document = parseDocument(existingText.replace(/\r\n/g, '\n'));
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      // Unchanged is judged with the loader's parser, as the read-back is: the definition was
      // read through it, and it does not agree with the library on every file (Bun keeps the
      // line break of a multi-line quoted scalar in a CRLF file, the library folds it).
      if (readsAs(existingText, definition)) return existingText;
      const state: MergeState = { doc, aliasValues: new Map() };
      doc.contents = merge(state, doc.contents, definition);
      settleAliases(state);
      return doc.toString(TO_STRING).replace(/\n/g, eol);
    }
    // An unparseable file on disk has no text worth keeping; the save replaces it.
  }
  return new Document(definition).toString(TO_STRING);
}
