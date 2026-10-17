/**
 * Bundled default commands, workflows and pack scripts, selected by `bundle-index.json`
 * and `bundle-inventory.ts`.
 *
 * The records come from `bundled-data.ts`. A source build reads them from the pack tree
 * on disk; a compiled binary embeds them as literals that `scripts/build-binaries.sh`
 * swaps in before compiling. This facade re-exports the records and owns the
 * binary-detection helper.
 */

import { BUNDLED_IS_BINARY } from '@archon/paths';

export {
  BUNDLED_COMMANDS,
  BUNDLED_SCRIPT_PACKS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_PATHS,
  BUNDLED_WORKFLOW_OWNERS,
} from './bundled-data';
export type { BundledWorkflowOwner } from './bundle-inventory';
export type { BundledScriptPack } from './bundled-script-pack';

/**
 * Check if the current process is running as a compiled binary (not via Bun CLI).
 *
 * Reads the build-time constant `BUNDLED_IS_BINARY` from `@archon/paths`.
 * `scripts/build-binaries.sh` rewrites that file to set it to `true` before
 * `bun build --compile` and restores it afterwards. See GitHub issue #979.
 *
 * Kept as a function (rather than a direct re-export of `BUNDLED_IS_BINARY`)
 * so tests can use `spyOn(bundledDefaults, 'isBinaryBuild').mockReturnValue(...)`
 * without resorting to `mock.module('@archon/paths', ...)` — which is
 * process-global and irreversible in Bun and would pollute other test files.
 * See `loader.test.ts` for context.
 */
export function isBinaryBuild(): boolean {
  return BUNDLED_IS_BINARY;
}
