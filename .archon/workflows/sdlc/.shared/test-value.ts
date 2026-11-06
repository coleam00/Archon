/**
 * The test-value judge's identity, and the metric records its verdicts make.
 *
 * The judge (`archon-metrics-test-value-judge`) says, for each test a pull request adds
 * or changes, whether it protects behavior. The metric workflow maps its verdicts on
 * merged factory pull requests to counts; the calibration workflow scores its verdicts
 * against hand labels. Both name the judge by the same identity, a hash of the judge
 * workflow's files and the criteria it inlines, so agreement is read for the judge that
 * produced the counts. The engine adds the models that ran the judge node.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { invokeForge, record, REMEDY } from './forge.ts';

/** The judge workflow's directory: every file in it is part of the judge. */
export const JUDGE_DIR = join(import.meta.dir, '..', 'metrics-test-value-judge');
/** The test-value criteria the judge inlines, read when it runs. */
const CRITERIA_FILE = join(import.meta.dir, '..', 'review', 'commands', 'review-tests.md');
/** The node that judges, in the judge workflow and in the fan-out that launches it. */
export const JUDGE_NODE = 'judge';

/** The forge operations the test-value metric reads through: each pull request, then each judge's files. */
export const TEST_VALUE_FORGE_OPERATIONS = ['pr.view', 'pr.files', 'repo.file'] as const;

/**
 * Refuse before any judge runs when a host's plugin lacks one of them. Each judge run
 * would otherwise fail on its own, and the metric would record nothing, with every
 * pull request listed as skipped.
 */
export function requireTestValueSource(hosts: Iterable<string>): void {
  for (const host of new Set(hosts)) {
    const capabilities = invokeForge('metadata', { host })?.capabilities;
    if (!Array.isArray(capabilities)) throw new Error('forge metadata returned no operation capabilities');
    const missing = TEST_VALUE_FORGE_OPERATIONS.filter(op => !capabilities.includes(op));
    if (missing.length > 0) {
      throw new Error(`the forge plugin for ${host} lacks the test-value metric's ${missing.join(', ')}. ${REMEDY.unsupported_op}`);
    }
  }
}

/** The project's calibration labels, relative to the checkout the calibration runs in. */
export const CASES_PATH = '.archon/sdlc/metrics/test-value-cases.json';

export interface JudgedTest {
  readonly file: string;
  readonly name: string;
  readonly protects: boolean;
  readonly reason: string;
}

/** One fan-out slot: the judge's verdict, or the engine's marker for a child that did not complete. */
export type JudgeSlot = { readonly ok: true; readonly tests: readonly JudgedTest[] } | { readonly ok: false; readonly error: string };

export interface LabeledTest {
  readonly file: string;
  readonly name: string;
  readonly protects: boolean;
}

export interface Case {
  readonly pr: string;
  readonly tests: readonly LabeledTest[];
}

/** A merged factory pull request, as the metric workflow hands it on, with the build-queue runs that built it. */
export interface MergedPr {
  readonly url: string;
  readonly merged_at: string;
  readonly runs: readonly string[];
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))
    .sort();
}

/** The criteria text exactly as the judge receives it, and as its identity hashes it. */
export function readCriteria(): string {
  return readFileSync(CRITERIA_FILE, 'utf8').trimEnd();
}

/** The judge's identity: a sha256 over the judge workflow's files and the criteria text. */
export function judgeIdentity(judgeDir = JUDGE_DIR, criteria = readCriteria()): string {
  const hash = createHash('sha256');
  for (const file of filesUnder(judgeDir)) {
    hash.update(`${relative(judgeDir, file)}\0`).update(readFileSync(file)).update('\0');
  }
  hash.update(criteria);
  return `test-value-judge:${hash.digest('hex').slice(0, 16)}`;
}

function judgedTest(value: unknown): JudgedTest {
  const row = record(value);
  if (typeof row?.file !== 'string' || typeof row.name !== 'string' || typeof row.protects !== 'boolean' || typeof row.reason !== 'string') {
    throw new Error('a judge verdict lists a test without file, name, protects and reason');
  }
  return { file: row.file, name: row.name, protects: row.protects, reason: row.reason };
}

/** An item the judge fanned out over, with its slot. */
export interface Judged<Item> {
  readonly item: Item;
  readonly slot: JudgeSlot;
}

/** The fan-out node's output paired with the items it ran over, which it reports in item order. */
export function judgeSlots<Item>(items: readonly Item[], value: unknown): Judged<Item>[] {
  if (!Array.isArray(value)) throw new Error('the judge fan-out did not report a list');
  if (value.length !== items.length) {
    throw new Error(`the judge fan-out reported ${String(value.length)} results for ${String(items.length)} pull requests`);
  }
  return items.map((item, index) => {
    const row = record(value[index]);
    if (row?.archon_failed === true) return { item, slot: { ok: false, error: `${String(row.status)}: ${String(row.error)}` } };
    if (!Array.isArray(row?.tests)) throw new Error('a judge result carries no tests');
    return { item, slot: { ok: true, tests: row.tests.map(judgedTest) } };
  });
}

/**
 * The judge's per-pull-request counts: tests added or changed, and those that protect no
 * behavior. A judge that did not complete makes no record; its pull request is skipped.
 */
export function testValueRecords(judged: readonly Judged<MergedPr>[], instrument: string) {
  const metrics: Record<string, unknown>[] = [];
  const skipped: { url: string; error: string }[] = [];
  for (const { item: pr, slot } of judged) {
    if (!slot.ok) {
      skipped.push({ url: pr.url, error: slot.error });
      continue;
    }
    // Both counts are the judge's, so both name it: a ratio never mixes two judges.
    const base = { kind: 'count', unit: 'tests', subject: pr.url, at: pr.merged_at, runs: pr.runs, instrument, instrument_node: JUDGE_NODE };
    metrics.push({ ...base, name: 'sdlc.tests_added', value: slot.tests.length });
    metrics.push({ ...base, name: 'sdlc.tests_unprotective', value: slot.tests.filter(test => !test.protects).length });
  }
  return { metrics, skipped };
}

/**
 * A test's identity across a label and a verdict: its file, and its name with template
 * placeholders (`${x}`, `<a|b>`, `%s`, `$x`) and punctuation dropped, so a parameterized
 * name written either way joins.
 */
/** A template placeholder in a test title: `${x}`, `<a|b>`, `%s` or `$x`. */
const PLACEHOLDER = /\$\{[^}]*\}|<[^>]*>|%[a-z]|\$[A-Za-z_]\w*/;

function testKey(file: string, name: string): string {
  const words = name
    .replace(new RegExp(PLACEHOLDER, 'g'), ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${file.trim()}::${words}`;
}

/** The calibration cases; an empty set is refused, since it would score nothing and pass. */
export function parseCases(value: unknown): Case[] {
  if (!Array.isArray(value)) throw new Error('the calibration cases are not a list');
  const cases = value.map(entry => {
    const row = record(entry);
    if (typeof row?.pr !== 'string' || !Array.isArray(row.tests)) throw new Error('a calibration case has no pr and tests');
    if (row.tests.length === 0) throw new Error(`the calibration case ${row.pr} labels no tests`);
    const tests = row.tests.map(test => {
      const fields = record(test);
      if (typeof fields?.file !== 'string' || typeof fields.name !== 'string' || typeof fields.protects !== 'boolean') {
        throw new Error(`a labeled test in ${row.pr as string} has no file, name and protects`);
      }
      return { file: fields.file, name: fields.name, protects: fields.protects };
    });
    const keys = tests.map(test => testKey(test.file, test.name));
    const repeated = tests.find((_, index) => keys.indexOf(keys[index] as string) !== index);
    // Two labels with one key would score the same verdict twice under one subject.
    if (repeated !== undefined) throw new Error(`${row.pr} labels two tests that read as ${repeated.file} > ${repeated.name}`);
    return { pr: row.pr, tests };
  });
  if (cases.length === 0) throw new Error('the calibration cases are empty');
  return cases;
}

/**
 * The verdict for a labeled test: the one with the same key, else the longest
 * parameterized one whose key starts the label's. A label may spell out a parameterized
 * test's cases, such as `preserves deletion` for the source's `preserves ${kind}`, or
 * annotate its parameters after the title, and the judge names the test as its source
 * writes it. A verdict without a placeholder joins only its own name.
 */
function verdictFor(pr: string, test: LabeledTest, verdicts: readonly JudgedTest[]): JudgedTest | undefined {
  const key = testKey(test.file, test.name);
  const keyed = verdicts.map(verdict => ({ verdict, key: testKey(verdict.file, verdict.name) }));
  const exact = keyed.filter(candidate => candidate.key === key);
  const prefixed = keyed.filter(candidate => PLACEHOLDER.test(candidate.verdict.name) && key.startsWith(`${candidate.key} `));
  const longest = Math.max(...prefixed.map(candidate => candidate.key.length));
  const joined = exact.length > 0 ? exact : prefixed.filter(candidate => candidate.key.length === longest);
  // Two verdicts one label joins would make its score depend on list order.
  if (joined.length > 1) {
    throw new Error(`the judge listed ${String(joined.length)} tests in ${pr} that the label ${test.file} > ${test.name} joins`);
  }
  return joined[0]?.verdict;
}

function testSubject(pr: string, test: LabeledTest): string {
  return `${pr}#${createHash('sha256').update(testKey(test.file, test.name)).digest('hex').slice(0, 16)}`;
}

/**
 * Score the judge against the labels, one 0/1 record per labeled test: agreement for
 * every test, and catch rate for the tests labeled unprotective. A labeled test the judge
 * did not list disagrees. Any case whose judge did not complete refuses the whole score:
 * agreement over a different subset of cases is not comparable across runs.
 */
export function scoreCalibration(judged: readonly Judged<Case>[], instrument: string) {
  const verdicts = judged.flatMap(({ item, slot }) => (slot.ok ? [{ entry: item, tests: slot.tests }] : []));
  const failed = judged.flatMap(({ item, slot }) => (slot.ok ? [] : [`${item.pr} (${slot.error})`]));
  if (failed.length > 0) throw new Error(`the judge did not complete for ${failed.join(', ')}; calibrate again`);
  const metrics: Record<string, unknown>[] = [];
  const disagreements: Disagreement[] = [];
  const base = { kind: 'score', unit: 'ratio', calibrates: 'sdlc.tests_unprotective', instrument, instrument_node: JUDGE_NODE };
  for (const { entry, tests } of verdicts) {
    for (const test of entry.tests) {
      const scored = scoreTest(entry.pr, test, verdictFor(entry.pr, test, tests));
      metrics.push(...scored.records.map(record => ({ ...base, ...record })));
      if (scored.disagreement !== undefined) disagreements.push(scored.disagreement);
    }
  }
  return { metrics, disagreements };
}

interface Disagreement {
  readonly pr: string;
  readonly file: string;
  readonly name: string;
  readonly label: boolean;
  readonly verdict: boolean | null;
  readonly reason: string;
}

/** One labeled test's agreement, its catch when labeled unprotective, and the disagreement if any. */
function scoreTest(pr: string, test: LabeledTest, verdict: JudgedTest | undefined) {
  const agrees = verdict?.protects === test.protects;
  const subject = testSubject(pr, test);
  const records = [{ name: 'sdlc.tests_unprotective_judge_agreement', subject, value: agrees ? 1 : 0 }];
  if (!test.protects) {
    records.push({ name: 'sdlc.tests_unprotective_judge_catch_rate', subject, value: verdict?.protects === false ? 1 : 0 });
  }
  const disagreement: Disagreement | undefined = agrees
    ? undefined
    : {
        pr,
        file: test.file,
        name: test.name,
        label: test.protects,
        verdict: verdict?.protects ?? null,
        reason: verdict?.reason ?? 'the judge did not list this test',
      };
  return { records, disagreement };
}
