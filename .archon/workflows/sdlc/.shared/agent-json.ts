/**
 * Reading JSON an agent wrote.
 *
 * Agents often write these files by hand, and on Windows two things then break a
 * strict parse that say nothing about the content: a UTF-8 byte-order mark
 * (PowerShell's `ConvertTo-Json` and `Out-File` add one), and a path such as
 * `C:\Users\...` written with single backslashes, which JSON reads as invalid
 * escapes (seen live: a delivery failed at publish-pr on "Invalid escape character
 * U"). Strict JSON is tried first; only when it fails is every backslash that does
 * not begin a valid JSON escape doubled and the parse retried. A path segment that
 * happens to start with a valid escape letter (`\n`, `\t`, ...) still decodes as
 * that control character, so callers that need a path the contract fixes should
 * derive it with {@link contractPath} rather than trust the agent's string.
 */

import { existsSync } from 'node:fs';

const BOM = /^\uFEFF/;
const ESCAPE = /\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g;

export function parseAgentJson(raw: string): unknown {
  const text = raw.replace(BOM, '');
  try {
    return JSON.parse(text) as unknown;
  } catch (strict) {
    const repaired = text.replace(ESCAPE, (match: string, valid: string | undefined) =>
      valid === undefined ? '\\\\' : match
    );
    if (repaired === text) throw strict;
    try {
      return JSON.parse(repaired) as unknown;
    } catch {
      throw strict;
    }
  }
}

/**
 * A file whose location the command contract fixes (for example
 * `$ARTIFACTS_DIR/pr-body.md`). The contract path wins when that file exists,
 * because the agent's copy of the path may have been mangled in transit; otherwise
 * the agent's value is used as given.
 */
export function contractPath(agentValue: string, contract: string): string {
  return existsSync(contract) ? contract : agentValue;
}
