/**
 * Build-time constants embedded into compiled binaries.
 *
 * In dev/test mode, the placeholders below are used and BUNDLED_IS_BINARY
 * is `false`. Compiled binaries get this file overwritten by
 * `scripts/build-binaries.sh` before `bun build --compile` is invoked,
 * and restored afterwards via an EXIT trap.
 *
 * Lives in `@archon/paths` (the bottom of the dep graph) so any package
 * can import these constants without creating dependency cycles.
 *
 * See GitHub issue #979 for the rationale (replaces runtime detection
 * heuristics that were brittle across Bun's ESM/CJS compile modes).
 */

export const BUNDLED_IS_BINARY = false;
export const BUNDLED_VERSION = 'dev';
export const BUNDLED_GIT_COMMIT = 'unknown';
