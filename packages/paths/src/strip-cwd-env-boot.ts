/**
 * Side-effect entry point: strips Bun-auto-loaded CWD .env keys at import time.
 *
 * Import this as the FIRST import in CLI entry points so it runs
 * before any module that reads process.env at initialization time.
 *
 * @example
 * // packages/cli/src/cli.ts — must be the very first import
 * import '@archon/paths/strip-cwd-env-boot';
 */
import { stripCwdEnv } from './strip-cwd-env';

stripCwdEnv();
