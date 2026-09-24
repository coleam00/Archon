/**
 * Set to `'1'` in the environment of a CLI process spawned to own a detached run.
 * Lives apart from `detached-run-control.ts` so the CLI entry point can read it
 * without loading `@archon/core`.
 */
export const DETACHED_RUN_OWNER_ENV = 'ARCHON_DETACHED_RUN_OWNER';
