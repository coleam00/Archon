/**
 * Perform the writes the deciding agent declared, and nothing else.
 *
 * Every check runs before the first write: each queued ref is decided exactly once, and
 * an issue a discovery is tracked by reads back open in the repository. Then the public
 * writes: a filing creates or recovers its issue by the key's marker, and an evidence
 * comment is upserted by the same marker, so a pass that stops anywhere and is run
 * again never files twice, and comments twice only when a write that landed returned
 * a 5xx and the listing lagged (the next upsert then refuses). Last, each run's document records the refs this
 * pass decided and the questions it asked, and its claim is released, except on a run
 * with an asked record: it stays claimed by this run until the question is answered and
 * the run ends.
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
  discoveryMarker,
  parseRunDocument,
  type Question,
  type Queue,
  refRun,
  runName,
} from '../../.shared/discoveries.ts';
import { forgeSource, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { createIssue, viewIssue } from '../../.shared/issue.ts';
import { upsertComment } from '../../.shared/pr.ts';
import { stateGet, statePut } from '../../.shared/state.ts';

const IDLE = 'No finished run has undecided discoveries.';

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
  const idle = trimmed(process.env.INPUTS_PATH) === 'idle';
  if (idle) {
    emit({ summary: IDLE, written: [], dropped: [], asked: [], question: '' });
    return;
  }
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  const queue = JSON.parse(readFileSync(join(artifactsDir(), 'drain', 'queue.json'), 'utf8')) as Queue;
  const decisions = (nullableJson(process.env.INPUTS_DECISIONS) ?? []) as AgentDecision[];
  const summary = text(process.env.INPUTS_SUMMARY);

  const problems = checkDecisions(
    queue.runs.flatMap(run => run.records.map(record => record.ref)),
    decisions
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

  // The public writes first. Each is found again by its marker, so a pass run again
  // after a stop never repeats one.
  const sha = queue.base.sha;
  const written: { key: string; outcome: 'file' | 'track'; url: string }[] = [];
  const source = forgeSource();
  for (const decision of decisions) {
    const marker = discoveryMarker(decision.key);
    if (decision.outcome === 'file') {
      const created = createIssue(repo, decision.title, issueBody(decision, sha), marker);
      written.push({ key: decision.key, outcome: 'file', url: created.url });
    } else if (decision.outcome === 'track') {
      const comment = decision.comment?.trim() || null;
      // One marked comment per key: later evidence replaces it in place.
      const url =
        comment === null
          ? issueUrl(decision.issue)
          : upsertComment({ kind: 'issue', ref: decision.issue }, marker, `${marker}\n${comment}`, source).url;
      written.push({ key: decision.key, outcome: 'track', url });
    }
  }

  // Then each run's memory: the refs decided this pass, and the questions asked. A run
  // with an asked record keeps this run's claim, so no other pass asks again while the
  // question waits.
  const self = trimmed(process.env.WORKFLOW_ID);
  for (const run of queue.runs) {
    const name = runName(run.id);
    const read = stateGet(name);
    const document = parseRunDocument(name, read.value);
    if (document?.claim?.run_id !== self) throw new Error(`${name} is no longer claimed by this run`);
    const ofRun = (refs: readonly string[]): string[] => refs.filter(ref => refRun(ref) === run.id);
    const decided = decisions.filter(decision => decision.outcome !== 'ask').flatMap(decision => ofRun(decision.refs));
    const questions: Question[] = asked
      .filter(decision => ofRun(decision.refs).length > 0)
      .map(decision => ({
        keys: [decision.key],
        refs: ofRun(decision.refs),
        text: decision.question,
        recommendation: decision.recommendation,
        answer: null,
      }));
    const next = {
      version: 1 as const,
      claim: questions.length > 0 ? document.claim : null,
      decided: [...new Set([...(document.decided ?? []), ...decided])],
      // A question this pass answered by deciding its refs is settled; one it asked again replaces it.
      questions: [
        ...(document.questions ?? []).filter(old =>
          old.refs.every(ref => !decided.includes(ref) && !questions.some(asking => asking.refs.includes(ref)))
        ),
        ...questions,
      ],
    };
    if (statePut(name, next, read.revision) === 'conflict') {
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
