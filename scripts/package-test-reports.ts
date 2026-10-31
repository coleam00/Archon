import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { SaxesParser } from 'saxes';
import { parseTestArguments } from './package-test-requests';

const countFields = ['tests', 'assertions', 'failures', 'skipped', 'errors', 'time'] as const;
type Counts = Record<(typeof countFields)[number], number>;
export interface TestReport {
  counts: Counts;
  suites: string;
}

function attributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/\b([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function parseReport(xml: string): TestReport {
  new SaxesParser().write(xml).close();
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

export function runnerErrorReport(message: string, name: string): TestReport {
  return {
    counts: { tests: 1, assertions: 0, failures: 0, skipped: 0, errors: 1, time: 0 },
    suites: `<testsuite name="runner" tests="1" errors="1"><testcase name="${escapeAttribute(name)}"><error message="${escapeAttribute(message)}" /></testcase></testsuite>`,
  };
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

export async function runReportedGroup(
  args: string[],
  run: (args: string[]) => Promise<number>
): Promise<{ code: number; report: TestReport }> {
  const groupName =
    parseTestArguments(args)
      .positionals.map(token => token.value)
      .join(' ') || 'Test process';
  const root = mkdtempSync(join(tmpdir(), 'archon-test-report-'));
  const reportPath = join(root, 'junit.xml');
  const options = ['--reporter=junit', `--reporter-outfile=${reportPath}`];
  const terminator = args.indexOf('--');
  const insertion = terminator < 0 ? args.length : terminator;
  try {
    const code = await run([...args.slice(0, insertion), ...options, ...args.slice(insertion)]);
    let report: TestReport;
    try {
      report = parseReport(readFileSync(reportPath, 'utf8'));
    } catch (error) {
      if (code === 0 && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // Bun emits no report for successful zero-file runs; it exposes no separate result flag.
        console.error(
          'Bun exited 0 without a JUnit report; retaining its exit code and reporting no results.'
        );
        return {
          code,
          report: {
            counts: { tests: 0, assertions: 0, failures: 0, skipped: 0, errors: 0, time: 0 },
            suites: '',
          },
        };
      }
      const message = `Unable to read Bun JUnit report: ${error instanceof Error ? error.message : String(error)}. Bun exited ${code} (see child output for diagnostics)`;
      console.error(message);
      return { code: code || 1, report: runnerErrorReport(message, groupName) };
    }
    if (code !== 0) {
      // Bun can omit load failures even when another test fails. Retain the process outcome.
      const failure = runnerErrorReport(
        `Bun exited ${code} (see child output for diagnostics)`,
        groupName
      );
      for (const field of countFields) report.counts[field] += failure.counts[field];
      report.suites += `\n${failure.suites}\n`;
    }
    return { code, report };
  } finally {
    await removeTempTree(root);
  }
}
