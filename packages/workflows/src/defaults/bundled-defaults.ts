/**
 * Bundled default commands and workflows for binary distribution.
 *
 * Content lives in `bundled-defaults.generated.ts`, which is regenerated from
 * `.archon/{commands,workflows}/defaults/` by `scripts/generate-bundled-defaults.ts`.
 * This file is the hand-written facade: it re-exports the records and defines
 * the binary-detection helper.
 *
 * Why two files:
 *   - Generated file is pure data — never hand-edited, diff on PRs shows
 *     exactly which defaults changed.
 *   - Facade keeps the documented `isBinaryBuild()` wrapper in a file that
 *     humans own.
 *
 * Why inline strings (and not `import X from '...file.md' with { type: 'text' }`)?
 *   - Node cannot load `type: 'text'` import attributes — it's Bun-specific.
 *     Using plain string literals keeps `@archon/workflows` importable from
 *     both runtimes, which removes SDK blocker #2.
 *   - Bun still embeds the data at compile time when building the CLI binary,
 *     so runtime behavior is unchanged.
 */

import { BUNDLED_IS_BINARY } from '@archon/paths';

export { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults.generated';

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
 * See `.claude/rules/dx-quirks.md` and `loader.test.ts` for context.
 */
export function isBinaryBuild(): boolean {
  return BUNDLED_IS_BINARY;
}
