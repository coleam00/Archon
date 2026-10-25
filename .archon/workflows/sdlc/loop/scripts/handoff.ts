/**
 * Hand the reviewer what earlier steps wrote, as files.
 *
 * Text one agent wrote, bound straight into another agent's prompt, is resolved again as part of
 * that prompt, so a builder report that quotes a workflow (`$review.output.outcome`) failed the
 * review before it began (mission control's pack-parser lap, 2026-10-24). A script's bindings
 * arrive as plain environment text, so this writes them to files the reviewer reads.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, text } from '../../.shared/io.ts';

const dir = join(artifactsDir(), 'handoff');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'builder.md'), text(process.env.INPUTS_BUILDER));
writeFileSync(join(dir, 'ship.json'), text(process.env.INPUTS_SHIP));
writeFileSync(join(dir, 'app-check.json'), text(process.env.INPUTS_APP_CHECK));
writeFileSync(join(dir, 'evidence-problems.txt'), text(process.env.INPUTS_EVIDENCE_PROBLEMS));
emit({ dir });
