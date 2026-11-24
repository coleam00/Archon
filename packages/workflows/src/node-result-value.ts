import type { JsonValue } from './output-ref';

/**
 * A completed node's value as the console's readers of a step's record take it: its structured
 * output when it recorded one, else its text output parsed as JSON. Undefined when it has
 * neither, or its text is not JSON: such output has no value to point into. This is not the
 * run result's rule: the engine's `recordedReturn` returns a text output as the string itself.
 */
export function nodeResultValue(structured: unknown, text: unknown): JsonValue | undefined {
  if (structured !== undefined) return structured as JsonValue;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
