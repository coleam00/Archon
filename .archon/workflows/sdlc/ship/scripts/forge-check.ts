/** Refuses the run before any agent spends when the forge plugin cannot act; see `.shared/forge-check.ts`. */

import { checkForgeAccess } from '../../.shared/forge-check.ts';
import { refuse, report } from '../../.shared/io.ts';

try {
  report(await checkForgeAccess());
} catch (error) {
  refuse(`forge-check: ${error instanceof Error ? error.message : String(error)}`);
}
