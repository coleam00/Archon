/**
 * The directory holding the pack's default policy documents, in this run's captured
 * source.
 *
 * A run captures the pack's source before it starts, from a binary's embedded bundle
 * as from a source checkout, and runs its scripts from that capture, so the defaults
 * are found from this file's own location rather than from any path the engine knows.
 * Each workflow's `policy` script node emits it; the agent reads the default and then the
 * project's document, which adds to it, and no code opens either.
 */

import { join } from 'node:path';

export const POLICY_DEFAULTS = join(import.meta.dir, 'policy');
