/** Refuses the run before any agent spends when its forge source cannot act; see `.shared/forge-check.ts`. */

import { checkForgeAccess } from '../../.shared/forge-check.ts';
import { emit, note, refuse } from '../../.shared/io.ts';

try {
  const { source, detail } = await checkForgeAccess();
  note(detail);
  emit({ source });
} catch (error) {
  refuse(`forge-check: ${error instanceof Error ? error.message : String(error)}`);
}
