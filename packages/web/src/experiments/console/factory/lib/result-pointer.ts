/**
 * The value at a JSON pointer (RFC 6901) in a run's result. The pointers come from the view
 * file, never from a run's prose; the result is the run's structured `returns:` value.
 */
import type { RunRecord } from '../api';

/** The value `pointer` names in a run's available result; undefined when it names nothing there. */
export function valueAt(record: Pick<RunRecord, 'returns'>, pointer: string): unknown {
  if (record.returns?.availability !== 'available') return undefined;
  return pointAt(record.returns.value, pointer);
}

/** The value `pointer` names in `value`; undefined when it is no pointer or names nothing. */
export function pointAt(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || String(index) !== key) return undefined;
      current = current[index];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else return undefined;
  }
  return current;
}
