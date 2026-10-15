/**
 * Perform the writes the deciding agent declared, and nothing else.
 *
 * Every check runs before the first write: each queued ref is decided exactly once, a
 * key that already has an issue is never filed again, and an issue a discovery is
 * tracked by reads back open in the repository. Then every decision record is
 * written, and only after that the public writes: each evidence comment, and each
 * filing whose issue does not exist yet, including one an earlier pass stopped in the
 * middle of. A filing creates or recovers its issue by the marker on the body's first
 * line, so a pass that stops anywhere never files twice. Last, each run's claim is
 * released, except on a run with an asked record: it stays claimed by this run until
 * the question is answered and the run ends.
 *
 * In eval mode the checks run and nothing is written; the decisions and every check
 * that would have refused the pass return as `evaluation`.
 *
 * Bound inputs: INPUTS_PATH from facts; INPUTS_DECISIONS and INPUTS_SUMMARY from the
 * agent, `null` when it did not run; the workflow's INPUTS_MODE, INPUTS_REPO_HOST and
 * INPUTS_REPO_PATH.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentDecision,
  checkDecisions,
  DECISIONS_PREFIX,
  type Decision,
  type DecisionRecord,
  decisionName,
  discoveryMarker,
  parseDecisionRecord,
  parseDrainMode,
  parseRunClaim,
  type Queue,
  refRun,
  runName,
} from '../../.shared/discoveries.ts';
import { forgeSource, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { createIssue, viewIssue } from '../../.shared/issue.ts';
import { upsertComment } from '../../.shared/pr.ts';
import { stateGet, stateList, statePatch, statePut } from '../../.shared/state.ts';

interface Stored {
  readonly revision: number;
  readonly record: DecisionRecord;
}

function readStored(): Map<string, Stored> {
  const stored = new Map<string, Stored>();
  for (const name of stateList(DECISIONS_PREFIX)) {
    const read = stateGet(name);
    if (read.value === null) continue;
    const record = parseDecisionRecord(name, read.value);
    stored.set(record.key, { revision: read.revision, record });
  }
  return stored;
}

function issueUrl(issue: { repo: { host: string; path: string }; number: number }): string {
  return `https://${issue.repo.host}/${issue.repo.path}/issues/${String(issue.number)}`;
}

/** The body a filed issue carries: the marker, the agent's brief, then where it came from. */
function issueBody(decision: AgentDecision & { outcome: 'file' }, sha: string): string {
  const runs = [...new Set(decision.refs.map(refRun))];
  return [
    discoveryMarker(decision.key),
    decision.body.trim(),
    '',
    '---',
    `Found by Archon run${runs.length === 1 ? '' : 's'} ${runs.join(', ')} and verified at ${sha} by the archon-discoveries workflow.`,
  ].join('\n');
}

function decided(decision: AgentDecision, sha: string): { decision: Decision; reason: string } {
  switch (decision.outcome) {
    case 'file':
      return {
        decision: { kind: 'filed', issue: null, title: decision.title, body: issueBody(decision, sha) },
        reason: decision.reason,
      };
    case 'track':
      return { decision: { kind: 'tracked', issue: decision.issue }, reason: decision.reason };
    case 'drop':
      return { decision: { kind: 'dropped' }, reason: decision.reason };
    case 'ask':
      return { decision: { kind: 'asked' }, reason: decision.recommendation };
  }
}

function main(): void {
  const mode = parseDrainMode(trimmed(process.env.INPUTS_MODE));
  if (trimmed(process.env.INPUTS_PATH) === 'idle') {
    emit({
      mode,
      summary: 'No finished run has undecided discoveries.',
      written: [],
      dropped: [],
      asked: [],
      question: '',
      evaluation: null,
    });
    return;
  }
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  const queue = JSON.parse(readFileSync(join(artifactsDir(), 'drain', 'queue.json'), 'utf8')) as Queue;
  const decisions = (nullableJson(process.env.INPUTS_DECISIONS) ?? []) as AgentDecision[];
  const summary = text(process.env.INPUTS_SUMMARY);
  const stored = readStored();

  const problems = checkDecisions(
    queue.runs.flatMap(run => run.records.map(record => record.ref)),
    decisions,
    new Map([...stored].map(([key, entry]) => [key, entry.record]))
  );
  for (const decision of decisions) {
    if (decision.outcome !== 'track') continue;
    if (!sameRepo(decision.issue.repo, repo)) {
      problems.push(`key ${decision.key} is tracked by an issue outside ${repo.host}/${repo.path}`);
      continue;
    }
    try {
      if (viewIssue(decision.issue).state !== 'open') {
        problems.push(`key ${decision.key} is tracked by ${issueUrl(decision.issue)}, which is not open`);
      }
    } catch (error) {
      problems.push(`key ${decision.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const dropped = decisions.flatMap(decision =>
    decision.outcome === 'drop' ? [{ key: decision.key, reason: decision.reason }] : []
  );
  const asked = decisions.filter(
    (decision): decision is AgentDecision & { outcome: 'ask' } => decision.outcome === 'ask'
  );

  if (mode === 'eval') {
    emit({
      mode,
      summary,
      written: [],
      dropped,
      asked: [],
      question: '',
      evaluation: { decisions, problems },
    });
    return;
  }
  if (problems.length > 0) throw new Error(`nothing was written: ${problems.join('; ')}`);

  // Every decision record first: a public write that lands after a stop is finished
  // from its record.
  const at = new Date().toISOString();
  const sha = queue.base.sha;
  for (const decision of decisions) {
    const before = stored.get(decision.key);
    const record: DecisionRecord = {
      version: 1,
      key: decision.key,
      title: decision.title,
      ...decided(decision, sha),
      verified_at: sha,
      at,
      refs: [...new Set([...(before?.record.refs ?? []), ...decision.refs])],
      question:
        decision.outcome === 'ask'
          ? { text: decision.question, recommendation: decision.recommendation, answer: null }
          : (before?.record.question ?? null),
    };
    if (statePut(decisionName(decision.key), record, before?.revision ?? 0) === 'conflict') {
      throw new Error(`${decisionName(decision.key)} changed while this pass decided it`);
    }
    stored.set(decision.key, { revision: (before?.revision ?? 0) + 1, record });
  }

  const written: { key: string; outcome: 'file' | 'track'; url: string }[] = [];
  const source = forgeSource();
  for (const decision of decisions) {
    if (decision.outcome !== 'track') continue;
    let url = issueUrl(decision.issue);
    if (decision.comment !== null) {
      // One marked comment per key: later evidence replaces it in place.
      const marker = discoveryMarker(decision.key);
      url = upsertComment({ kind: 'issue', ref: decision.issue }, marker, `${marker}\n${decision.comment.trim()}`, source).url;
    }
    written.push({ key: decision.key, outcome: 'track', url });
  }
  for (const { record } of stored.values()) {
    if (record.decision.kind !== 'filed' || record.decision.issue !== null) continue;
    const created = createIssue(repo, record.decision.title, record.decision.body, discoveryMarker(record.key));
    statePatch(decisionName(record.key), [{ op: 'set', path: '/decision/issue', value: created.issue }]);
    written.push({ key: record.key, outcome: 'file', url: created.url });
  }

  // A run with an asked record keeps this run's claim, so no other pass asks again
  // while the question waits.
  const askedRuns = new Set(asked.flatMap(decision => decision.refs.map(refRun)));
  const self = trimmed(process.env.WORKFLOW_ID);
  for (const run of queue.runs) {
    const name = runName(run.id);
    const read = stateGet(name);
    const claim = parseRunClaim(name, read.value)?.claim ?? null;
    if (claim?.run_id !== self) throw new Error(`${name} is no longer claimed by this run`);
    if (askedRuns.has(run.id)) continue;
    if (statePut(name, { version: 1, claim: null }, read.revision) === 'conflict') {
      throw new Error(`${name} changed while this run held its claim`);
    }
  }

  emit({
    mode,
    summary,
    written,
    dropped,
    asked: asked.map(decision => decision.key),
    question: asked
      .map(
        (decision, index) =>
          `${String(index + 1)}. ${decision.key}: ${decision.question}\n   Recommended: ${decision.recommendation}`
      )
      .join('\n'),
    evaluation: null,
  });
}

try {
  main();
} catch (error) {
  refuse(`discoveries outcome: ${error instanceof Error ? error.message : String(error)}`);
}
