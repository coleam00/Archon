import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runReportedGroup, writeCombinedReport } from './package-test-reports';

const track = trackTempRoots();

function reportDestination(args: string[]): string {
  const option = args.find(arg => arg.startsWith('--reporter-outfile='));
  if (option === undefined) throw new Error('Missing private report destination');
  return option.slice('--reporter-outfile='.length);
}

for (const damage of ['partial', 'invalid-count', 'unreadable']) {
  for (const childCode of [0, 1, 7]) {
    test(`damaged ${damage} report after exit ${childCode} fails the group and retains later reports`, async () => {
      const root = track(mkdtempSync(join(tmpdir(), 'package-report-')));
      for (const namePattern of [undefined, 'wanted']) {
        let privatePath = '';
        const damaged = await runReportedGroup(
          ['first.test.ts'],
          async args => {
            privatePath = reportDestination(args);
            if (damage === 'unreadable') mkdirSync(privatePath);
            else
              writeFileSync(
                privatePath,
                damage === 'partial' ? '<testsuites' : '<testsuites tests="invalid"></testsuites>'
              );
            return childCode;
          },
          namePattern
        );
        expect(damaged.code).toBe(childCode || 1);
        expect(damaged.report.counts.errors).toBe(1);
        expect(damaged.report.suites).toContain('first.test.ts');
        expect(damaged.report.suites).toContain(`Bun exited ${childCode}`);
        expect(damaged.report.suites).toContain('see child output for diagnostics');
        expect(damaged.report.suites).toContain('Unable to read Bun JUnit report');
        expect(existsSync(privatePath)).toBe(false);

        const later = await runReportedGroup(
          ['later.test.ts'],
          async args => {
            const destination = reportDestination(args);
            writeFileSync(
              destination,
              '<testsuites tests="1"><testsuite name="later"><testcase name="wanted" /></testsuite></testsuites>'
            );
            return 0;
          },
          namePattern
        );
        expect(later.code).toBe(0);
        const combined = join(root, 'combined.xml');
        writeCombinedReport(combined, [damaged.report, later.report]);
        const xml = readFileSync(combined, 'utf8');
        expect(xml).toContain('name="later"');
        expect(xml).toContain('name="first.test.ts"');
        expect(xml).toMatch(/<testsuites[^>]*errors="1"/);
      }
    });
  }
}
