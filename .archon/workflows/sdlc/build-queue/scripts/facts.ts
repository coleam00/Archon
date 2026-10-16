/**
 * Claim the build queue's next item and write the issue the deciding agents read.
 *
 * Live claims the waiting item that sorts first with intake's claim and order, and
 * writes only that claim. A closed issue goes to `closed`, which apply parks without
 * an agent. Eval claims nothing and writes nothing outside the run's artifacts: it
 * reads the named issue's body at `as_of` and replays the rounds it was given.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_PICKUP, type BuildRound, countedRounds } from '../../.shared/build.ts';
import type { QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { issueBodyAt, viewIssue } from '../../.shared/issue.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { isObject } from '../../.shared/typed.ts';
import { claimNext, parseMode, parseOrder, readWorkItem, type WorkItem, withPlainReports } from '../../.shared/workitem.ts';

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** The `replay` input: recorded rounds, each with every field a live round stores. */
function parseReplay(value: string): BuildRound[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim() === '' ? '[]' : value);
  } catch {
    throw new Error('replay is not a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('replay is not a JSON array');
  return parsed.map((round, index) => {
    if (
      !isObject(round) ||
      typeof round.run_id !== 'string' ||
      typeof round.at !== 'string' ||
      typeof round.delivered !== 'boolean' ||
      typeof round.reason !== 'string' ||
      typeof round.pr_url !== 'string' ||
      typeof round.summary !== 'string' ||
      typeof round.artifacts !== 'string'
    ) {
      throw new Error(
        `replay[${String(index)}] is not {run_id, at, delivered, reason, pr_url, summary, artifacts}`
      );
    }
    return {
      run_id: round.run_id,
      at: round.at,
      delivered: round.delivered,
      reason: round.reason,
      pr_url: round.pr_url,
      summary: round.summary,
      artifacts: round.artifacts,
    };
  });
}

/** Write the issue every agent reads; its path is fixed so the prompts name it. */
function writeIssue(title: string, url: string, body: string, asOf: string): void {
  const dir = join(artifactsDir(), 'build');
  mkdirSync(dir, { recursive: true });
  const when = asOf === '' ? 'now' : `as it was at ${asOf}`;
  writeFileSync(join(dir, 'issue.md'), `# ${title}\n\n${url}, ${when}.\n\n${body}\n`);
}

function emitItem(
  path: 'closed' | 'route' | 'answer',
  subject: QualifiedPr,
  url: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  recorded: BuildRound | null,
  atCap: boolean
): void {
  emit({
    path,
    item: subject,
    url,
    record: doc === null ? null : withPlainReports(doc),
    brief: doc?.facts.build?.brief ?? '',
    rounds,
    recorded,
    at_cap: atCap,
    policy_defaults: POLICY_DEFAULTS,
  });
}

function main(): void {
  const mode = parseMode(text(process.env.INPUTS_MODE));
  const limit = positive('round_limit', trimmed(process.env.INPUTS_ROUND_LIMIT));
  const order = parseOrder(text(process.env.INPUTS_ORDER));
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  if (mode === 'eval') {
    const subject = { repo, number: positive('number', trimmed(process.env.INPUTS_NUMBER)) };
    const replay = parseReplay(text(process.env.INPUTS_REPLAY));
    const asOf = trimmed(process.env.INPUTS_AS_OF);
    const issue = viewIssue(subject);
    writeIssue(issue.title, issue.url, asOf === '' ? issue.body : issueBodyAt(subject, asOf), asOf);
    const doc = readWorkItem(subject.number);
    const recorded = replay.at(-1) ?? null;
    emitItem(
      recorded === null ? 'route' : 'answer',
      subject,
      issue.url,
      doc,
      replay.slice(0, -1),
      recorded,
      replay.length >= limit
    );
    return;
  }

  const doc = claimNext(order, new Date().toISOString(), runId, BUILD_PICKUP);
  if (doc === null) {
    emit({
      path: 'idle',
      item: null,
      url: '',
      record: null,
      brief: '',
      rounds: [],
      recorded: null,
      at_cap: false,
      policy_defaults: POLICY_DEFAULTS,
    });
    return;
  }
  const issue = viewIssue(doc.subject);
  writeIssue(issue.title, issue.url, issue.body, '');
  emitItem(
    issue.state === 'closed' ? 'closed' : 'route',
    doc.subject,
    issue.url,
    doc,
    doc.facts.build?.rounds ?? [],
    null,
    countedRounds(doc) + 1 >= limit
  );
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
