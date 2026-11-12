/** Refuses the run before any agent spends when the forge plugin cannot act; see `../forge-check.ts`. */

import { checkForgeAccess } from '../forge-check.ts';
import { refuse } from 'archon:script';

try {
  console.log(checkForgeAccess());
} catch (error) {
  refuse(`forge-check: ${error instanceof Error ? error.message : String(error)}`);
}
