/**
 * Inline one review-eval sample for the judge, which runs with no tools: the defects
 * the change was planted with, the case's known defects, every lens's output under
 * its own name, and the review's findings and report.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuse, report, trimmed } from '../../.shared/io.ts';
import { FINDINGS_FILE, REPORT_FILE, readItem } from '../../.shared/review-item.ts';

const dir = trimmed(process.env.INPUTS_ITEM);

function file(path: string): string {
  return readFileSync(join(dir, path), 'utf8').trimEnd();
}

try {
  if (dir === '') throw new Error('the `item` input names no item directory');
  const item = readItem(dir);
  const sections = [
    `<defects>\n${JSON.stringify(item.defects, null, 2)}\n</defects>`,
    `<known_defects>\n${JSON.stringify(item.known_defects, null, 2)}\n</known_defects>`,
    ...Object.entries(item.lenses).map(([lens, path]) => `<lens name="${lens}" file="${path}">\n${file(path)}\n</lens>`),
    `<findings file="${FINDINGS_FILE}">\n${file(FINDINGS_FILE)}\n</findings>`,
    `<report file="${REPORT_FILE}">\n${existsSync(join(dir, REPORT_FILE)) ? file(REPORT_FILE) : '(absent)'}\n</report>`,
  ];
  report(`Lenses that left output: ${Object.keys(item.lenses).join(', ') || 'none'}.\n\n${sections.join('\n\n')}`);
} catch (error) {
  refuse(`read-item: ${error instanceof Error ? error.message : String(error)}`);
}
