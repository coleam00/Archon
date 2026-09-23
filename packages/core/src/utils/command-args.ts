/**
 * Quote a value as one `parseCommand` argument, for slash-command suggestions
 * shown to a user who may paste them back verbatim.
 *
 * Without the quotes, a name with a space splits into several arguments; without
 * escaping `"` and `\`, a name containing a quote ends the quoted token early.
 * `parseCommand` honours backslash escapes inside quotes, so the result parses
 * back to exactly `value`.
 */
export function quoteCommandArg(value: string): string {
  return `"${value.replace(/[\\"]/g, c => `\\${c}`)}"`;
}
