import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { normalizeTestSelector, parseTestArguments } from './package-test-requests';

const countFields = ['tests', 'assertions', 'failures', 'skipped', 'errors', 'time'] as const;
type Counts = Record<(typeof countFields)[number], number>;
interface TestReport {
  counts: Counts;
  suites: string;
  files: Set<string>;
}

function attributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/\b([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function parseReport(xml: string): TestReport {
  // Bun owns this XML envelope. Keep suite bodies intact, including escaped failure text.
  const envelope =
    /^\s*(?:<\?xml[^?]*\?>\s*)?<testsuites\b([^>]*)>([\s\S]*)<\/testsuites>\s*$/.exec(xml);
  if (envelope === null) throw new Error('Bun wrote an unsupported JUnit report');
  const attrs = attributes(envelope[1]);
  const counts: Counts = { tests: 0, assertions: 0, failures: 0, skipped: 0, errors: 0, time: 0 };
  for (const field of countFields) {
    counts[field] = Number(attrs.get(field) ?? 0);
    if (!Number.isFinite(counts[field])) throw new Error(`Invalid JUnit ${field} count`);
  }
  return {
    counts,
    suites: envelope[2],
    files: new Set(
      [...envelope[2].matchAll(/<testsuite\b[^>]*>/g)]
        .map(match => attributes(match[0]).get('file'))
        .filter((file): file is string => file !== undefined)
    ),
  };
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}

export function writeCombinedReport(destination: string, reports: TestReport[]): void {
  const totals = countFields.map(
    field => `${field}="${reports.reduce((sum, report) => sum + report.counts[field], 0)}"`
  );
  writeFileSync(
    destination,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" ${totals.join(' ')}>\n${reports.map(report => report.suites).join('\n')}\n</testsuites>\n`
  );
}

function isEmptyNameFilter(report: TestReport, args: string[]): boolean {
  const { tests, skipped, failures, errors } = report.counts;
  const files = parseTestArguments(args).positionals.map(token =>
    escapeAttribute(normalizeTestSelector(process.cwd(), token.value))
  );
  return (
    tests > 0 &&
    tests === skipped &&
    failures === 0 &&
    errors === 0 &&
    files.length > 0 &&
    files.every(file => report.files.has(file))
  );
}

/** Bun exits 1 for an empty name filter; missing file suites can also mean a load error. */
export async function runReportedGroup(
  args: string[],
  run: (args: string[]) => Promise<number>,
  filtersNames: boolean
): Promise<{ code: number | 'no-name-match'; report: TestReport }> {
  const root = mkdtempSync(join(tmpdir(), 'archon-test-report-'));
  const reportPath = join(root, 'junit.xml');
  const options = ['--reporter=junit', `--reporter-outfile=${reportPath}`];
  const terminator = args.indexOf('--');
  const insertion = terminator < 0 ? args.length : terminator;
  try {
    const code = await run([...args.slice(0, insertion), ...options, ...args.slice(insertion)]);
    const report = existsSync(reportPath)
      ? parseReport(readFileSync(reportPath, 'utf8'))
      : {
          counts: { tests: 0, assertions: 0, failures: 0, skipped: 0, errors: 0, time: 0 },
          suites: '',
          files: new Set<string>(),
        };
    if (filtersNames && code === 1 && isEmptyNameFilter(report, args)) {
      return { code: 'no-name-match', report };
    }
    if (code !== 0 && report.counts.failures === 0 && report.counts.errors === 0) {
      // Bun omits load failures from JUnit. Preserve the failed process in the combined report.
      report.counts.tests++;
      report.counts.errors++;
      report.suites += `\n<testsuite name="runner" tests="1" errors="1"><testcase name="${escapeAttribute(args.join(' '))}"><error message="Bun exited ${code} without a reported test failure" /></testcase></testsuite>\n`;
    }
    return { code, report };
  } finally {
    await removeTempTree(root);
  }
}
