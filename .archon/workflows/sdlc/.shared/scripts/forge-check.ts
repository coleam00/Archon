/** Refuses the run before any agent spends when the forge plugin cannot act; see `../forge-check.ts`. */

import { checkForgeAccess } from '../forge-check.ts';
import { refuse, report } from '../io.ts';

try {
  report(await checkForgeAccess());
} catch (error) {
  refuse(`forge-check: ${error instanceof Error ? error.message : String(error)}`);
}
