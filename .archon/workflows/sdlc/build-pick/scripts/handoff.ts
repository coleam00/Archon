/**
 * File the new work the run's message described, and start intake on it.
 *
 * New work enters only through intake, so the run that filed it never builds it:
 * intake triages the issue and routes it, and the queue picks it up from there. The
 * issue's body begins with a marker naming this run, so a retried node recovers the
 * issue it already filed instead of filing a second one, and fires its intake start
 * with the same delivery id.
 *
 * Bound inputs: INPUTS_REPO from start, INPUTS_ISSUE (title and body) from interpret;
 * the workflow's INPUTS_INTAKE_BINDING.
 */

import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { startIntake } from '../../.shared/build.ts';
import { nullableJson, record } from '../../.shared/inputs.ts';
import { createIssue } from '../../.shared/issue.ts';

function main(): void {
  const runId = workflowRunId();
  const repo = nullableJson(input('repo')) as { host: string; path: string };
  const issue = record(nullableJson(input('issue')));
  if (typeof issue?.title !== 'string' || typeof issue.body !== 'string' || issue.title.trim() === '' || issue.body.trim() === '') {
    throw new Error('interpret declared new work without a title and body');
  }
  const marker = `<!-- archon-build-queue-request: ${runId} -->`;
  const created = createIssue(repo, issue.title.trim(), `${marker}\n\n${issue.body.trim()}`, marker);
  const intake = startIntake({ repo, number: created.issue.number }, runId);
  emit({ summary: `Filed ${created.url} as new work and started intake on it (${intake}); intake triages it before any queue builds it.` });
}

try {
  main();
} catch (error) {
  refuse(`build-pick handoff: ${error instanceof Error ? error.message : String(error)}`);
}
