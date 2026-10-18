/**
 * Perform the writes the deciding agent declared, and nothing else.
 *
 * Every check runs before the first write: each queued ref is decided exactly once, a
 * key that already has an issue is never filed again, and an issue a discovery is
 * tracked by reads back open in the repository. Then every decision record is
 * written, and only after that every public write a record still owes: an evidence
 * comment not yet posted, and a filing whose issue does not exist yet, including ones
 * an earlier pass stopped in the middle of. An idle live pass does only that. A filing
 * creates or recovers its issue, and a comment is upserted, by the key's marker, so a
 * pass that stops anywhere never files or comments twice. Last, each run's claim is
 * released, except on a run with an asked record: it stays claimed by this run until
 * the question is answered and the run ends.
 *
 * Bound inputs: INPUTS_PATH from facts; INPUTS_DECISIONS and INPUTS_SUMMARY from the
 * agent, `null` when it did not run; the workflow's INPUTS_REPO_HOST and
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
  parseRunClaim,
  type Queue,
  refRun,
  runName,
  unfinished,
} from '../../.shared/discoveries.ts';
import { forgeSource, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { createIssue, viewIssue } from '../../.shared/issue.ts';
import { upsertComment } from '../../.shared/pr.ts';
import { stateDocuments, stateGet, statePatch, statePut } from '../../.shared/state.ts';

const IDLE = 'No finished run has undecided discoveries.';

interface Stored {
  readonly revision: number;
  readonly record: DecisionRecord;
}

function readStored(): Map<string, Stored> {
  const stored = new Map<string, Stored>();
  for (const { name, revision, value } of stateDocuments(DECISIONS_PREFIX)) {
    const record = parseDecisionRecord(name, value);
    stored.set(record.key, { revision, record });
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

function decided(
  decision: AgentDecision,
  prior: Decision | undefined,
  sha: string
): { decision: Decision; reason: string } {
  switch (decision.outcome) {
    case 'file':
      return { decision: { kind: 'filed', issue: null, body: issueBody(decision, sha) }, reason: decision.reason };
    case 'track': {
      // New evidence replaces an owed comment; no new evidence keeps it owed. The
      // check already refused a track on another issue while one is owed.
      const fresh = decision.comment?.trim() || null;
      const owed = prior?.kind === 'tracked' ? prior.comment : null;
      return {
        decision: { kind: 'tracked', issue: decision.issue, comment: fresh ?? owed },
        reason: decision.reason,
      };
    }
    case 'drop':
      return { decision: { kind: 'dropped' }, reason: decision.reason };
    case 'ask':
      return { decision: { kind: 'asked' }, reason: decision.recommendation };
  }
}

function main(): void {
  const idle = trimmed(process.env.INPUTS_PATH) === 'idle';
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  // An idle live pass still finishes what an earlier pass's records owe.
  const queue = JSON.parse(readFileSync(join(artifactsDir(), 'drain', 'queue.json'), 'utf8')) as Queue;
  const decisions = idle ? [] : ((nullableJson(process.env.INPUTS_DECISIONS) ?? []) as AgentDecision[]);
  const summary = idle ? IDLE : text(process.env.INPUTS_SUMMARY);
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
      ...decided(decision, before?.record.decision, sha),
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

  // Then every public write a record still owes, this pass's and any an earlier pass
  // stopped before finishing. Each is found again by its marker, so none repeats.
  const written: { key: string; outcome: 'file' | 'track'; url: string }[] = [];
  const source = forgeSource();
  for (const { record } of stored.values()) {
    const owed = record.decision;
    if (!unfinished(owed)) continue;
    const marker = discoveryMarker(record.key);
    if (owed.kind === 'filed') {
      const created = createIssue(repo, record.title, owed.body, marker);
      statePatch(decisionName(record.key), [{ op: 'set', path: '/decision/issue', value: created.issue }]);
      written.push({ key: record.key, outcome: 'file', url: created.url });
    } else if (owed.kind === 'tracked') {
      // One marked comment per key: later evidence replaces it in place.
      const comment = upsertComment({ kind: 'issue', ref: owed.issue }, marker, `${marker}\n${owed.comment}`, source);
      statePatch(decisionName(record.key), [{ op: 'set', path: '/decision/comment', value: null }]);
      written.push({ key: record.key, outcome: 'track', url: comment.url });
    }
  }
  for (const decision of decisions) {
    if (decision.outcome === 'track' && !written.some(entry => entry.key === decision.key)) {
      written.push({ key: decision.key, outcome: 'track', url: issueUrl(decision.issue) });
    }
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
  });
}

try {
  main();
} catch (error) {
  refuse(`discoveries outcome: ${error instanceof Error ? error.message : String(error)}`);
}
