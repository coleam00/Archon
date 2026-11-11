/**
 * The lines a merged factory pull request added, split into test and production, as
 * metric records: evidence of how much test a change carries, never a gate.
 *
 * Lines are counted from the patches the forge's `pr.files` reports, one read per pull
 * request, so the caller bounds the reads by merge time. A file the forge reports
 * without a patch (binary, or a diff too large to render) cannot be counted, so its
 * pull request is skipped with the reason rather than counted short.
 */

import { type PrFacts, prRuns } from './factory-prs.ts';
import { forge } from 'archon:script';
import { prFromUrl } from './pr.ts';

/** A test file, by its path: under a `__tests__`, `test(s)` or `spec` directory, `*.test.*`, `*_spec.*`, or `test_*`. Every other file is production. */
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._](test|spec)\.|(^|\/)test_[^/]+$/;

export interface PrFile {
  readonly path: string;
  readonly status: string;
  readonly patch: string | null;
}

export interface LineRecord {
  readonly name: 'sdlc.test_lines_added' | 'sdlc.production_lines_added';
  readonly kind: 'count';
  readonly unit: 'lines';
  readonly value: number;
  readonly subject: string;
  readonly at: string;
  readonly runs: readonly string[];
}

/** The pull request's changed files, read through the forge. */
export function readPrFiles(url: string): PrFile[] {
  const pr = prFromUrl(url);
  const files = forge('pr.files', { ref: { repo: pr.repo, number: pr.number } })?.files;
  if (!Array.isArray(files)) throw new Error(`forge pr.files returned no file list for ${url}`);
  return files.map(row => {
    const file = row as Record<string, unknown>;
    if (typeof file.path !== 'string' || typeof file.status !== 'string') throw new Error(`forge pr.files returned an invalid file for ${url}`);
    return { path: file.path, status: file.status, patch: typeof file.patch === 'string' ? file.patch : null };
  });
}

/** Added lines in test and production files, or why they cannot be counted. */
export function addedLines(files: readonly PrFile[]): { test: number; production: number } | { reason: string } {
  let test = 0;
  let production = 0;
  for (const file of files) {
    // A removed file adds nothing, with or without a patch.
    if (file.status === 'removed') continue;
    if (file.patch === null) return { reason: `the forge reports no patch for ${file.path}` };
    const added = file.patch.split('\n').filter(line => line.startsWith('+')).length;
    if (TEST_PATH.test(file.path)) test += added;
    else production += added;
  }
  return { test, production };
}

/** Each merged pull request's test and production lines added, at its merge, attributed like the PR outcome records. */
export function lineRecords(
  prs: readonly PrFacts[],
  runsByUrl: ReadonlyMap<string, readonly string[]>,
  readFiles: (url: string) => readonly PrFile[]
): { metrics: LineRecord[]; skipped: { url: string; reason: string }[] } {
  const metrics: LineRecord[] = [];
  const skipped: { url: string; reason: string }[] = [];
  for (const pr of prs) {
    if (pr.mergedAt === null) throw new Error(`the forge reported ${pr.url} merged without a time`);
    const lines = addedLines(readFiles(pr.url));
    if ('reason' in lines) {
      skipped.push({ url: pr.url, reason: lines.reason });
      continue;
    }
    const base = { kind: 'count', unit: 'lines', subject: pr.url, at: pr.mergedAt, runs: prRuns(runsByUrl, pr.url) } as const;
    metrics.push(
      { ...base, name: 'sdlc.test_lines_added', value: lines.test },
      { ...base, name: 'sdlc.production_lines_added', value: lines.production }
    );
  }
  return { metrics, skipped };
}
