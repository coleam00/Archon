/**
 * One review-eval sample as the bench leaves it under `<out>/items/<run_id>/`: the
 * run's `review/` directory and `shape.md`, and `item.json`, which names the defects
 * the sample was planted with, the case's known defects, and which files are lens
 * outputs. The bench writes it; the judge's `read-item` and the bench's own
 * judgement validation read it, so both see the same defects and lenses.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObject } from './typed.ts';

export const ITEM_FILE = 'item.json';
export const FINDINGS_FILE = 'review/findings.json';
export const REPORT_FILE = 'review/report.md';

export interface ItemDefect {
  readonly id: string;
  readonly class: string;
  readonly owner: string;
  readonly claim: string;
  readonly location: string;
}

/** A real defect of the clean change, so a finding that states it is no false positive. */
export interface KnownDefect {
  readonly id: string;
  readonly claim: string;
}

export interface ItemRecord {
  readonly defects: readonly ItemDefect[];
  readonly known_defects: readonly KnownDefect[];
  /** Each lens that left output, to its file relative to the item directory. */
  readonly lenses: Readonly<Record<string, string>>;
}

export const FINDING_VALUES = {
  severity: ['blocking', 'note'],
  status: ['open', 'fixed', 'declined', 'disproved'],
} as const;

/** One record of the review's `findings.json`. */
export interface Finding {
  readonly id: string;
  readonly severity: (typeof FINDING_VALUES.severity)[number];
  readonly sources: readonly string[];
  readonly claim: string;
  readonly status: (typeof FINDING_VALUES.status)[number];
  readonly round: number;
}

export function writeItem(dir: string, item: ItemRecord): void {
  writeFileSync(join(dir, ITEM_FILE), `${JSON.stringify(item, null, 2)}\n`);
}

const texts = (value: unknown, ...keys: string[]): value is Record<string, unknown> =>
  isObject(value) && keys.every(key => typeof value[key] === 'string');

// Every field of a defect is text; typing the key lists by the interfaces makes a field
// added to either one fail to compile here until `readItem` checks it.
const ITEM_DEFECT_KEYS: Record<keyof ItemDefect, true> = { id: true, class: true, owner: true, claim: true, location: true };
const KNOWN_DEFECT_KEYS: Record<keyof KnownDefect, true> = { id: true, claim: true };

export function readItem(dir: string): ItemRecord {
  const file = join(dir, ITEM_FILE);
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !isObject(raw) ||
    !Array.isArray(raw.defects) ||
    !raw.defects.every(defect => texts(defect, ...Object.keys(ITEM_DEFECT_KEYS))) ||
    !Array.isArray(raw.known_defects) ||
    !raw.known_defects.every(defect => texts(defect, ...Object.keys(KNOWN_DEFECT_KEYS))) ||
    !isObject(raw.lenses) ||
    !Object.values(raw.lenses).every(path => typeof path === 'string')
  ) {
    throw new Error(`${file} is not a review-eval item`);
  }
  return raw as unknown as ItemRecord;
}

export function readFindings(dir: string): Finding[] {
  const file = join(dir, FINDINGS_FILE);
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const isFinding = (record: unknown): record is Finding =>
    texts(record, 'id', 'severity', 'claim', 'status') &&
    FINDING_VALUES.severity.some(value => value === record.severity) &&
    FINDING_VALUES.status.some(value => value === record.status) &&
    typeof record.round === 'number' &&
    Number.isInteger(record.round) &&
    record.round >= 1 &&
    Array.isArray(record.sources) &&
    record.sources.every(source => typeof source === 'string');
  if (!Array.isArray(raw) || !raw.every(isFinding)) throw new Error(`${file} is not a list of findings`);
  const ids = new Set<string>();
  for (const finding of raw) {
    if (ids.has(finding.id)) throw new Error(`${file}: duplicate finding id ${finding.id}`);
    ids.add(finding.id);
  }
  return raw;
}
