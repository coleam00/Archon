import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { parser } from 'sax';
import { runReportedGroup, writeCombinedReport } from './package-test-reports';

const track = trackTempRoots();

function reportDestination(args: string[]): string {
  const option = args.find(arg => arg.startsWith('--reporter-outfile='));
  if (option === undefined) throw new Error('Missing private report destination');
  return option.slice('--reporter-outfile='.length);
}

const damagedReports = {
  partial: '<testsuites',
  'raw-ampersand-attribute': '<testsuites><testsuite name="a & b" /></testsuites>',
  'raw-less-than-attribute': '<testsuites><testsuite name="a < b" /></testsuites>',
  'undeclared-attribute-entity': '<testsuites><testsuite name="&missing;" /></testsuites>',
  'undeclared-text-entity': '<testsuites><testsuite>&missing;</testsuite></testsuites>',
  'invalid-count': '<testsuites tests="invalid"></testsuites>',
  'unclosed-suite': '<testsuites tests="1"><testsuite name="first"></testsuites>',
  'unclosed-testcase':
    '<testsuites tests="1"><testsuite name="first"><testcase name="one"></testsuites>',
  'mismatched-tags':
    '<testsuites tests="1"><testsuite name="first"><testcase name="one"></testsuite></testcase></testsuites>',
  'invalid-attribute': '<testsuites><testsuite name="first><testcase /></testsuite></testsuites>',
};

for (const [damage, damagedXml] of [...Object.entries(damagedReports), ['unreadable', undefined]]) {
  for (const childCode of [0, 1, 7]) {
    test(`damaged ${damage} report after exit ${childCode} fails the group and retains later reports`, async () => {
      const root = track(mkdtempSync(join(tmpdir(), 'package-report-')));
      let privatePath = '';
      const damaged = await runReportedGroup(['first.test.ts'], async args => {
        privatePath = reportDestination(args);
        if (damagedXml === undefined) mkdirSync(privatePath);
        else writeFileSync(privatePath, damagedXml);
        return childCode;
      });
      expect(damaged.code).toBe(childCode || 1);
      expect(damaged.report.counts.errors).toBe(1);
      expect(damaged.report.suites).toContain('first.test.ts');
      expect(damaged.report.suites).toContain(`Bun exited ${childCode}`);
      expect(damaged.report.suites).toContain('see child output for diagnostics');
      expect(damaged.report.suites).toContain('Unable to read Bun JUnit report');
      expect(existsSync(privatePath)).toBe(false);

      const later = await runReportedGroup(['later.test.ts'], async args => {
        const destination = reportDestination(args);
        writeFileSync(
          destination,
          `<testsuites tests="1"><testsuite name="later"><testcase name="wanted" /></testsuite></testsuites>`
        );
        return 0;
      });
      expect(later.code).toBe(0);
      const combined = join(root, 'combined.xml');
      writeCombinedReport(combined, [damaged.report, later.report]);
      const xml = readFileSync(combined, 'utf8');
      expect(() => parser(true).write(xml).close()).not.toThrow();
      expect(xml).toContain('name="later"');
      expect(xml).toContain('name="first.test.ts"');
      expect(xml).toMatch(/<testsuites[^>]*errors="1"/);
    });
  }
}

for (const content of [
  '<testcase name="a &amp; b &lt; c &quot;quoted&quot; &apos;single&apos; &#65; &#x42;" />',
  '<testcase name="failure"><failure>expected &lt;value&gt; &amp; actual</failure></testcase>',
  '<testcase name="failure"><failure><![CDATA[expected <value> & actual]]></failure></testcase>',
]) {
  test(`valid escaped report content survives aggregation: ${content}`, async () => {
    const root = track(mkdtempSync(join(tmpdir(), 'package-report-')));
    const suites = `<testsuite name="valid">${content}</testsuite>`;
    const result = await runReportedGroup(['valid.test.ts'], async args => {
      writeFileSync(reportDestination(args), `<testsuites tests="1">${suites}</testsuites>`);
      return 0;
    });
    expect(result.code).toBe(0);
    expect(result.report.suites).toBe(suites);
    const combined = join(root, 'combined.xml');
    writeCombinedReport(combined, [result.report]);
    expect(() => parser(true).write(readFileSync(combined, 'utf8')).close()).not.toThrow();
  });
}
