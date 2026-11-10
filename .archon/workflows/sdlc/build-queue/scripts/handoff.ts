/**
 * File the new work the run's message described, and start intake on it.
 *
 * New work enters only through intake, so the run that filed it never builds it:
 * intake triages the issue and routes it, and the queue picks it up from there. The
 * issue's body begins with a marker naming this run, so a retried node recovers the
 * issue it already filed instead of filing a second one.
 *
 * Bound inputs: INPUTS_REPO from start, INPUTS_ISSUE (title and body) from interpret.
 */

import { record } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, workflowRunId } from '../../.shared/io.ts';
import { createIssue } from '../../.shared/issue.ts';
import { launchDetached } from '../../.shared/launch.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

function main(): void {
  const runId = workflowRunId();
  const repo = nullableJson(process.env.INPUTS_REPO) as NodeOutput<'archon-build-queue', 'start'>['repo'];
  const issue = record(nullableJson(process.env.INPUTS_ISSUE));
  if (typeof issue?.title !== 'string' || typeof issue.body !== 'string' || issue.title.trim() === '' || issue.body.trim() === '') {
    throw new Error('interpret declared new work without a title and body');
  }
  const marker = `<!-- archon-build-queue-request: ${runId} -->`;
  const created = createIssue(repo, issue.title.trim(), `${marker}\n\n${issue.body.trim()}`, marker);
  const intake = launchDetached('archon-intake', {
    repo_host: repo.host,
    repo_path: repo.path,
    number: String(created.issue.number),
  });
  emit<NodeOutput<'archon-build-queue', 'handoff'>>({ summary: `Filed ${created.url} as new work and started intake on it (run ${intake}); intake triages it before any queue builds it.` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue handoff: ${error instanceof Error ? error.message : String(error)}`);
}
