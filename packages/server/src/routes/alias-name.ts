import { isTierName } from '@archon/workflows/model-validation';

/**
 * Validate a custom alias name: must start with '@' and not shadow a tier
 * keyword. Returns the error message, or null for a valid name.
 *
 * The console's alias form runs a copy of this rule before saving
 * (`aliasNameError` in the web settings skill); `scripts/alias-name-parity.test.ts`
 * keeps the two identical.
 */
export function validateAliasName(name: string): string | null {
  if (isTierName(name)) {
    return `Alias name '${name}' is reserved (small/medium/large are tier keywords). Use a different name.`;
  }
  if (!name.startsWith('@')) {
    return `Alias name '${name}' must start with '@' (e.g. '@${name}').`;
  }
  return null;
}
