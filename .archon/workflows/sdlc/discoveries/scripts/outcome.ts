/**
 * Perform the writes the deciding agent declared, and nothing else.
 *
 * Every check runs before the first write: each queued ref is decided exactly once, a
 * key that already has an issue is never filed again, and an issue a discovery is
 * tracked by reads back open in the repository. Then, per decision, the decision
 * record is written first and the public write second, so a pass that stops between
 * the two leaves a record the next pass finishes by its marker instead of filing
 * twice. Last, each run's document records which key its refs were decided under and
 * drops this pass's claim, except on a run with an asked record: that run stays
 * claimed by this run until the question is answered and the run ends.
 *
 * In eval mode nothing is written: the checks run, and the whole decision returns as
 * `evaluation`.
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
  parseRunDoc,
  type Queue,
  type Question,
  refRun,
  runName,
} from '../../.shared/discoveries.ts';
import { forgeSource, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { createIssue, viewIssue } from '../../.shared/issue.ts';
import { upsertComment } from '../../.shared/pr.ts';
import { stateGet, stateList, statePatch, statePut } from '../../.shared/state.ts';

interface Written {
  readonly key: string;
  readonly outcome: AgentDecision['outcome'];
  readonly url: string | null;
}

function readStored(): Map<string, { revision: number; record: DecisionRecord }> {
  const stored = new Map<string, { revision: number; record: DecisionRecord }>();
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

function main(): void {
  const mode = parseDrainMode(trimmed(process.env.INPUTS_MODE));
  if (trimmed(process.env.INPUTS_PATH) === 'idle') {
    emit({ mode, summary: 'No finished run has undecided discoveries.', written: [], dropped: [], asked: [], question: '', evaluation: null });
    return;
  }
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  const queue = JSON.parse(readFileSync(join(artifactsDir(), 'drain', 'queue.json'), 'utf8')) as Queue;
  const decisions = (nullableJson(process.env.INPUTS_DECISIONS) ?? []) as AgentDecision[];
  const summary = text(process.env.INPUTS_SUMMARY);
  const queued = queue.runs.flatMap(run => run.records.map(record => record.ref));
  const stored = readStored();

  const problems = checkDecisions(
    queued,
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

  if (mode === 'eval') {
    emit({
      mode,
      summary,
      written: [],
      dropped: [],
      asked: [],
      question: '',
      evaluation: { base: queue.base, runs: queue.runs.map(run => run.id), decisions, problems },
    });
    return;
  }
  if (problems.length > 0) throw new Error(`nothing was written: ${problems.join('; ')}`);

  const at = new Date().toISOString();
  const sha = queue.base.sha;
  const source = forgeSource();
  const written: Written[] = [];

  // Finish a filing an earlier pass stopped in the middle of: its draft becomes the
  // issue its marker recovers or creates.
  const decidedNow = new Set(decisions.map(decision => decision.key));
  for (const { record } of stored.values()) {
    if (record.decision.kind !== 'filed' || record.decision.draft === null || decidedNow.has(record.key)) continue;
    const created = createIssue(repo, record.decision.draft.title, record.decision.draft.body, discoveryMarker(record.key));
    statePatch(decisionName(record.key), [{ op: 'set', path: '/decision', value: { kind: 'filed', issue: created.issue, draft: null } }]);
    written.push({ key: record.key, outcome: 'file', url: created.url });
  }

  for (const decision of decisions) {
    const name = decisionName(decision.key);
    const before = stored.get(decision.key);
    const runs = [...new Set([...(before?.record.runs ?? []), ...decision.refs.map(refRun)])];
    let next: Decision;
    let question: Question | null = before?.record.question ?? null;
    let reason: string;
    switch (decision.outcome) {
      case 'file':
        next = { kind: 'filed', issue: null, draft: { title: decision.title, body: issueBody(decision, sha) } };
        reason = decision.reason;
        break;
      case 'track': {
        const prior = before?.record.decision;
        const sameIssue = prior?.kind === 'tracked' && prior.issue.number === decision.issue.number;
        next = { kind: 'tracked', issue: decision.issue, comment_url: sameIssue ? prior.comment_url : null };
        reason = decision.reason;
        break;
      }
      case 'drop':
        next = { kind: 'dropped' };
        reason = decision.reason;
        break;
      case 'ask':
        next = { kind: 'asked' };
        question = { text: decision.question, recommendation: decision.recommendation, answer: null };
        reason = 'waiting for a maintainer';
        break;
    }
    const record: DecisionRecord = {
      version: 1,
      key: decision.key,
      title: decision.title,
      decision: next,
      reason,
      verified_at: sha,
      at,
      runs,
      question,
    };
    // The record first: a public write that lands after a stop is recovered from it.
    if (statePut(name, record, before?.revision ?? 0) === 'conflict') {
      throw new Error(`${name} changed while this pass decided it`);
    }
    if (decision.outcome === 'file' && next.kind === 'filed' && next.draft !== null) {
      const created = createIssue(repo, next.draft.title, next.draft.body, discoveryMarker(decision.key));
      statePatch(name, [{ op: 'set', path: '/decision', value: { kind: 'filed', issue: created.issue, draft: null } }]);
      written.push({ key: decision.key, outcome: 'file', url: created.url });
    } else if (decision.outcome === 'track' && decision.comment !== null) {
      const marker = discoveryMarker(decision.key);
      const comment = upsertComment({ kind: 'issue', ref: decision.issue }, marker, `${marker}\n${decision.comment.trim()}`, source);
      statePatch(name, [{ op: 'set', path: '/decision/comment_url', value: comment.url }]);
      written.push({ key: decision.key, outcome: 'track', url: comment.url });
    } else if (decision.outcome === 'track') {
      written.push({ key: decision.key, outcome: 'track', url: issueUrl(decision.issue) });
    }
  }

  // Each run records its decided refs. A run with an asked record keeps this run's
  // claim, so no other pass asks again while the question waits.
  const keyOf = new Map<string, AgentDecision>();
  for (const decision of decisions) for (const ref of decision.refs) keyOf.set(ref, decision);
  for (const run of queue.runs) {
    const docName = runName(run.id);
    const read = stateGet(docName);
    const doc = parseRunDoc(docName, read.value);
    if (doc?.claim?.run_id !== trimmed(process.env.WORKFLOW_ID)) {
      throw new Error(`${docName} is no longer claimed by this run`);
    }
    const decided = { ...doc.decided };
    let waiting = false;
    for (const record of run.records) {
      const decision = keyOf.get(record.ref);
      if (decision === undefined) continue;
      if (decision.outcome === 'ask') waiting = true;
      else decided[record.ref.slice(run.id.length + 1)] = decision.key;
    }
    if (statePut(docName, { version: 1, claim: waiting ? doc.claim : null, decided }, read.revision) === 'conflict') {
      throw new Error(`${docName} changed while this run held its claim`);
    }
  }

  const asked = decisions.filter(
    (decision): decision is AgentDecision & { outcome: 'ask' } => decision.outcome === 'ask'
  );
  emit({
    mode,
    summary,
    written,
    dropped: decisions
      .filter(decision => decision.outcome === 'drop')
      .map(decision => ({ key: decision.key, reason: decision.outcome === 'drop' ? decision.reason : '' })),
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
