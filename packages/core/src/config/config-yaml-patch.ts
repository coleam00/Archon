import { isDeepStrictEqual } from 'util';
import { isMap, isScalar, parseDocument, YAMLMap, type Document } from 'yaml';
import { isConfigRecord } from './config-validation';

type YamlMap = Record<string, unknown>;

/**
 * `text` with `next` written over `current` (what `text` parses to), changing only the keys
 * whose value differs, so comments, key order and block layout survive. The file's line
 * endings are kept. A key that is missing or undefined in `next` is removed.
 *
 * `yaml` edits the document, but the loader reads it with Bun's parser, and the two can
 * disagree (`<<` merge keys, repeated keys, an anchor shared by other keys). The caller must
 * check that the result loads back as `next` before writing it.
 */
export function patchYamlText(text: string, current: object, next: object): string {
  // uniqueKeys: false accepts a map with more than one `<<` merge key, which Bun reads.
  // Typed as a plain Document: the parsed type does not let a new map replace the root.
  const document: Document = parseDocument(text, { uniqueKeys: false });
  if (document.errors.length > 0) throw document.errors[0];
  // The loader reads a `~` or `null` file as no settings; give it a map to write into,
  // keeping the comments that sat on the null.
  const root = document.contents;
  if (isScalar(root) && root.value === null) {
    const map = new YAMLMap(document.schema);
    map.commentBefore = root.commentBefore;
    map.comment = root.comment;
    document.contents = map;
  }
  patchMap(document, [], current as YamlMap, next as YamlMap);
  // lineWidth 0 keeps a long string on one line instead of folding it.
  const patched = document.toString({ lineWidth: 0 });
  return text.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched;
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
