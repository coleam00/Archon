import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

function isEmptyNameFilterReport(xml: string): boolean {
  const suite = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  if (suite === undefined) return false;
  const counts = new Map(
    [...suite.matchAll(/\b(tests|failures|skipped|errors)="(\d+)"/g)].map(match => [
      match[1],
      Number(match[2]),
    ])
  );
  return (
    (counts.get('tests') ?? 0) > 0 &&
    counts.get('tests') === counts.get('skipped') &&
    counts.get('failures') === 0 &&
    (counts.get('errors') ?? 0) === 0
  );
}

/** Bun exits 1 for an empty name filter; other groups may still contain a match. */
export async function runNameFilteredGroup(
  args: string[],
  run: (args: string[]) => Promise<number>,
  reporterOutfile: string | undefined
): Promise<number | 'no-name-match'> {
  const root = mkdtempSync(join(tmpdir(), 'archon-test-name-filter-'));
  const report = join(root, 'junit.xml');
  const options = ['--reporter=junit', `--reporter-outfile=${report}`];
  const terminator = args.indexOf('--');
  const insertion = terminator < 0 ? args.length : terminator;
  try {
    const code = await run([...args.slice(0, insertion), ...options, ...args.slice(insertion)]);
    // Load errors may prevent Bun from writing a report. They remain failures.
    const xml = existsSync(report) ? readFileSync(report, 'utf8') : undefined;
    if (xml !== undefined && reporterOutfile !== undefined) writeFileSync(reporterOutfile, xml);
    return code === 1 && xml !== undefined && isEmptyNameFilterReport(xml) ? 'no-name-match' : code;
  } finally {
    await removeTempTree(root);
  }
}
