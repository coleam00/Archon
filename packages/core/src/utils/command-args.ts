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

export function parseSlashCommand(text: string): { command: string; args: string[] } {
  const matches: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let hasToken = false;

  for (const char of text.trim()) {
    if (quote) {
      hasToken = true;
      if (escaping) {
        current += char;
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        matches.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    if (!hasToken && (char === '"' || char === "'")) {
      quote = char;
      hasToken = true;
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaping) {
    current += '\\';
  }
  if (hasToken) {
    matches.push(current);
  }

  if (matches.length === 0 || !matches[0]) {
    return { command: '', args: [] };
  }

  if (!matches[0].startsWith('/')) {
    return { command: '', args: [] };
  }

  const command = matches[0].substring(1); // Remove leading '/'
  const args = matches.slice(1);

  return { command, args };
}
