/**
 * Hand the triage prompt the directory holding the pack's default policy documents.
 *
 * A run captures the pack's source before it starts, from a binary's embedded bundle
 * as from a source checkout, and runs this script from that capture, so the defaults
 * are found from this file's own location rather than from any path the engine knows.
 * The agent chooses between the project's document and the default; no code opens either.
 */

import { join } from 'node:path';
import { emit } from '../../.shared/io.ts';

emit({ defaults: join(import.meta.dir, '../../.shared/policy') });
