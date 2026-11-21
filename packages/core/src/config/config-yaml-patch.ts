import { isDeepStrictEqual } from 'util';
import { isMap, isScalar, parseDocument, visit, YAMLMap, type Document, type Node } from 'yaml';
import { isConfigRecord } from './config-validation';

/**
 * `text` with `next` written over `current` (`text` parsed), changing only the keys whose
 * value differs. Comments, blank lines and block layout are kept; the document is re-rendered,
 * so formatting details of untouched parts (flow-collection spacing, sequence indent) can
 * change. A key that is missing or undefined in `next` is removed.
 */
export function patchYamlText(text: string, current: object, next: object): string {
  const document = parseDocument(text, { uniqueKeys: false });
  if (document.errors.length > 0) throw document.errors[0];
  normalize(document);
  patchMap(document, [], current as YamlMap, next as YamlMap);
  // lineWidth 0 keeps a long string on one line instead of folding it.
  return document.toString({ lineWidth: 0 });
}

type YamlMap = Record<string, unknown>;

/**
 * Make the document's tree match what Bun's parser reads, so a write to a path lands on the
 * value that is in effect: an alias becomes a copy of its value (a write must not change every
 * node sharing an anchor, and removing an anchor must not leave a dangling alias), a repeated
 * key keeps its last pair (Bun reads the last one, `setIn` would edit the first), and a
 * `null` or `~` root becomes an empty map.
 */
function normalize(document: Document): void {
  let aliased = false;
  visit(document, {
    Alias(_, alias) {
      aliased = true;
      return alias.resolve(document)?.clone() as Node | undefined;
    },
  });
  if (aliased) {
    visit(document, {
      Node(_, node) {
        node.anchor = undefined;
      },
    });
  }
  visit(document, {
    Map(_, map) {
      const seen = new Set<unknown>();
      const last = [...map.items].reverse().filter(pair => {
        const key = isScalar(pair.key) ? pair.key.value : pair.key;
        return !seen.has(key) && seen.add(key);
      });
      if (last.length !== map.items.length) map.items = last.reverse();
    },
  });
  if (isScalar(document.contents) && document.contents.value === null) {
    const root = new YAMLMap(document.schema);
    root.commentBefore = document.contents.commentBefore;
    root.comment = document.contents.comment;
    root.spaceBefore = document.contents.spaceBefore;
    document.contents = root;
  }
}

function patchMap(document: Document, path: string[], current: YamlMap, next: YamlMap): void {
  for (const key of Object.keys(current)) {
    if (next[key] === undefined) document.deleteIn([...path, key]);
  }
  for (const [key, value] of Object.entries(next)) {
    const before = current[key];
    if (value === undefined || isDeepStrictEqual(before, value)) continue;
    const here = [...path, key];
    // An alias or scalar at this path cannot take a nested write, so it is replaced whole.
    if (isConfigRecord(before) && isConfigRecord(value) && isMap(document.getIn(here, true))) {
      patchMap(document, here, before, value);
    } else {
      document.setIn(here, value);
    }
  }
}
