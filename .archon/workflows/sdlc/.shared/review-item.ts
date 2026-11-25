/**
 * The files a review run leaves in its artifact directory: the findings it settled, the
 * set publish-review last published, and the commit it reviewed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObject } from './inputs.ts';

export const FINDINGS_FILE = 'review/findings.json';
/**
 * The review a run last published, as one set publish-review writes together: the
 * report, its findings and the commit it reviewed. A later review continues from this
 * set, never from the working `report.md`, which the next round's synthesis rewrites
 * before that round publishes anything.
 */
export const PUBLISHED_DIR = 'published';
export const PUBLISHED_REPORT_FILE = `review/${PUBLISHED_DIR}/report.md`;
export const REVIEWED_HEAD_FILE = 'reviewed-head';

export const FINDING_VALUES = {
  severity: ['blocking', 'note'],
  status: ['open', 'fixed', 'declined', 'disproved'],
  /** A blocker's own action, from least to most severe. */
  action: ['correct', 'replan', 'ask'],
} as const;

/** How the review's verifiers demoted a blocker; settle-review writes it. */
export interface FindingVerify {
  readonly against: number;
  readonly reasons: readonly string[];
}

/** One record of the review's `findings.json`. */
export interface Finding {
  readonly id: string;
  readonly severity: (typeof FINDING_VALUES.severity)[number];
  readonly sources: readonly string[];
  readonly claim: string;
  readonly status: (typeof FINDING_VALUES.status)[number];
  readonly round: number;
  /** The action this blocker alone needs; synthesis writes it on blocking records. */
  readonly action?: (typeof FINDING_VALUES.action)[number];
  readonly verify?: FindingVerify;
}

const texts = (value: unknown, ...keys: string[]): value is Record<string, unknown> =>
  isObject(value) && keys.every(key => typeof value[key] === 'string');

export function readFindings(dir: string): Finding[] {
  return readFindingsFile(join(dir, FINDINGS_FILE));
}

/** One `findings.json` at any path, such as the one beside a previous round's report. */
export function readFindingsFile(file: string): Finding[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const isFinding = (record: unknown): record is Finding =>
    texts(record, 'id', 'severity', 'claim', 'status') &&
    FINDING_VALUES.severity.some(value => value === record.severity) &&
    FINDING_VALUES.status.some(value => value === record.status) &&
    typeof record.round === 'number' &&
    Number.isInteger(record.round) &&
    record.round >= 1 &&
    Array.isArray(record.sources) &&
    record.sources.every(source => typeof source === 'string') &&
    (record.action === undefined || FINDING_VALUES.action.some(value => value === record.action)) &&
    (record.verify === undefined ||
      (isObject(record.verify) &&
        typeof record.verify.against === 'number' &&
        Array.isArray(record.verify.reasons) &&
        record.verify.reasons.every(reason => typeof reason === 'string')));
  if (!Array.isArray(raw) || !raw.every(isFinding)) throw new Error(`${file} is not a list of findings`);
  const ids = new Set<string>();
  for (const finding of raw) {
    if (ids.has(finding.id)) throw new Error(`${file}: duplicate finding id ${finding.id}`);
    ids.add(finding.id);
  }
  return raw;
}
