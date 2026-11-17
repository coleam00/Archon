/**
 * RFC 6901 JSON Pointers over JSON values. A trigger maps event and run data into a
 * started workflow's inputs with them, so every source reads a pointer the same way.
 */
import type { JsonValue } from './output-ref';

export function isJsonPointer(pointer: string): boolean {
  return (pointer === '' || pointer.startsWith('/')) && !/~(?:[^01]|$)/.test(pointer);
}

/** The value `pointer` names in `value`, or undefined when it names nothing there. */
export function resolveJsonPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (!isJsonPointer(pointer)) return undefined;
  if (pointer === '') return value;
  let current: JsonValue | undefined = value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = current[key];
    } else return undefined;
  }
  return current;
}
