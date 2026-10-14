/** Refuses the run before any agent spends when its forge source cannot act; see `.shared/forge-check.ts`. */

import { checkForgeAccess } from '../../.shared/forge-check.ts';
import { emit, refuse } from '../../.shared/io.ts';

try {
  emit(checkForgeAccess());
} catch (error) {
  refuse(`forge-check: ${error instanceof Error ? error.message : String(error)}`);
}
