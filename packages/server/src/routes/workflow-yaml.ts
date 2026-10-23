/**
 * Serialize a workflow definition for saving while keeping the authored YAML text.
 *
 * The builder sends the whole definition on every save. Re-serializing it from scratch drops
 * every comment and reflows the file, so instead the new definition is merged into the parsed
 * document of the file already on disk, which keeps comments and scalar styles.
 *
 * Existing scalar edits replace parser-owned source tokens, keeping unrelated bytes intact.
 * Structural edits and changes involving anchors or aliases use the document merge instead.
 * Both paths must read back as the submitted definition before a save can write them.
 */
import { CST, Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Alias, Node, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { parseYaml } from '@archon/workflows/loader';

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

function tryRenderScalarEdits(definition: Plain, source: string): string | undefined {
  const doc = parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
  const edits: { start: number; end: number; text: string }[] = [];

  function collect(node: unknown, value: unknown, inFlow: boolean): boolean {
    const previous: unknown = isNode(node) ? node.toJS(doc) : node;
    if (Bun.deepEquals(previous, value)) return true;
    // Shared sources need alias settlement; tagged values need schema-aware merging.
    if (!isNode(node) || isAlias(node) || node.anchor || node.tag) return false;
    if (isMap(node) && isPlainObject(value)) return collectMap(node, value, inFlow);
    if (isSeq(node) && Array.isArray(value)) return collectSequence(node, value, inFlow);
    return collectScalar(node, value, inFlow);
  }

  function collectMap(node: YAMLMap, value: Plain, inFlow: boolean): boolean {
    const keys = Object.keys(value).filter(key => value[key] !== undefined);
    if (keys.length !== node.items.length) return false;
    return node.items.every(
      ({ key, value: child }) =>
        isScalar(key) &&
        typeof key.value === 'string' &&
        keys.includes(key.value) &&
        collect(child, value[key.value], inFlow || node.flow === true)
    );
  }

  function collectSequence(node: YAMLSeq, value: unknown[], inFlow: boolean): boolean {
    if (node.items.length !== value.length) return false;
    return node.items.every((child, index) => {
      const oldValue: unknown = isNode(child) ? child.toJS(doc) : child;
      if (itemId(oldValue) !== itemId(value[index])) return false;
      return collect(child, value[index], inFlow || node.flow === true);
    });
  }

  function collectScalar(node: Node, value: unknown, inFlow: boolean): boolean {
    if (
      !isScalar(node) ||
      (value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean')
    ) {
      return false;
    }
    const token = node.srcToken;
    if (!token || !CST.isScalar(token) || token.source.length === 0) return false;
    const original = CST.stringify(token);
    const start = token.offset;
    const end = start + original.length;
    if (source.slice(start, end) !== original) return false;

    // CST renders strings without schema resolution. Use the document serializer to
    // distinguish plain strings from values such as "true" that require quoting.
    const canonical = new Document(value).toString({ ...TO_STRING, blockQuote: false });
    const scalar = parseDocument(canonical).contents;
    if (!isScalar(scalar)) return false;
    const replacement = structuredClone(token);
    CST.setScalarValue(replacement, typeof value === 'string' ? value : canonical.trimEnd(), {
      // CST's afterKey adds continuation indentation for both map and sequence values.
      afterKey: true,
      inFlow,
      type: typeof value !== 'string' ? 'PLAIN' : node.type === 'PLAIN' ? scalar.type : undefined,
    });
    const eol = original.includes('\r\n')
      ? '\r\n'
      : original.includes('\n')
        ? '\n'
        : source.includes('\r\n')
          ? '\r\n'
          : '\n';
    edits.push({
      start,
      end,
      text: CST.stringify(replacement).replace(/\r\n/g, '\n').replace(/\n/g, eol),
    });
    return true;
  }

  if (!collect(doc.contents, definition, false)) return undefined;
  let text = source;
  let boundary = source.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > boundary || edit.start < 0) return undefined;
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    boundary = edit.start;
  }
  return text;
}

interface MergeState {
  doc: Document;
  /** The value each kept alias stands for, for settleAliases to write out if it must. */
  aliasValues: Map<Alias, unknown>;
}

/** Merge `value` into `node` in place when the shapes match; return the node to keep. */
function merge(state: MergeState, node: unknown, value: unknown): Node {
  if (isAlias(node)) return mergeAlias(state, node, value);
  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    return mergeScalar(state.doc, node, value);
  }
  if (isMap(node) && isPlainObject(value)) return mergeMap(state, node, value);
  if (isSeq(node) && Array.isArray(value)) return mergeSeq(state, node, value);
  return state.doc.createNode(value);
}

/**
 * The definition arrives as JSON, so an alias comes back as a copy of its anchor's value. While
 * the copy still equals the anchored node, the alias stays; once it differs, the alias is
 * replaced by its own value.
 */
function mergeAlias(state: MergeState, alias: Alias, value: unknown): Node {
  const target = alias.resolve(state.doc);
  if (target && Bun.deepEquals(target.toJS(state.doc), value)) {
    state.aliasValues.set(alias, value);
    return alias;
  }
  return state.doc.createNode(value);
}

function mergeScalar(doc: Document, node: Scalar, value: unknown): Node {
  if (node.value === value) return node;
  // Same scalar kind keeps the node, and with it its comments and quoting style.
  if (typeof node.value === typeof value) {
    node.value = value;
    return node;
  }
  return doc.createNode(value);
}

function mergeMap(state: MergeState, node: YAMLMap, value: Plain): Node {
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

function mergeSeq(state: MergeState, node: YAMLSeq, value: unknown[]): Node {
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
  moveLeadingComment(node, oldItems[0]);
  return node;
}

/**
 * The library attaches the comment above the first item to the sequence itself; when that
 * item moves, its comment goes with it.
 */
function moveLeadingComment(seq: YAMLSeq, first: unknown): void {
  if (!seq.commentBefore || !isNode(first)) return;
  if (seq.items[0] === first || !seq.items.includes(first)) return;
  first.commentBefore = [seq.commentBefore, first.commentBefore].filter(Boolean).join('\n');
  seq.commentBefore = undefined;
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
    read = parseYaml(text);
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
    if (readsAs(existingText, definition)) return existingText;
    const scalarEdits = tryRenderScalarEdits(definition, existingText);
    if (scalarEdits !== undefined) return scalarEdits;
    // Work in LF: the library keeps a CR inside comments of a CRLF file and ends lines with LF,
    // which would mix the two. The file's line ending is restored at the end.
    const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
    // Widened from Document.Parsed: merged-in nodes are created, not parsed.
    const doc: Document = parseDocument(existingText.replace(/\r\n/g, '\n'));
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      const state: MergeState = { doc, aliasValues: new Map() };
      doc.contents = merge(state, doc.contents, definition);
      settleAliases(state);
      return doc.toString(TO_STRING).replace(/\n/g, eol);
    }
    // An unparseable file on disk has no text worth keeping; the save replaces it.
  }
  return new Document(definition).toString(TO_STRING);
}
