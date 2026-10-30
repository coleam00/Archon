/**
 * Claim the split queue's next item and write the issue the slice agent splits.
 *
 * It claims the waiting item that sorts first with intake's claim and order, or the
 * item the `number` input names, and writes only that claim. A named item that cannot
 * be claimed refuses the run with the reason. A closed issue goes to `closed`, which
 * publish records without an agent. The issues already filed from the item come from
 * its work item, where publish records each one as it files it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { SPLIT_PICKUP } from '../../.shared/split.ts';
import { claimNamed, claimNext } from '../../.shared/workitem.ts';

function main(): void {
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  if (trimmed(process.env.INPUTS_REPO_HOST) === '' || trimmed(process.env.INPUTS_REPO_PATH) === '') {
    throw new Error('repo_host and repo_path are required');
  }
  const at = new Date().toISOString();
  const named = trimmed(process.env.INPUTS_NUMBER);
  const number = Number(named);
  if (named !== '' && (!Number.isInteger(number) || number <= 0)) throw new Error('number must be a positive integer');
  const doc = named === '' ? claimNext(at, runId, SPLIT_PICKUP) : claimNamed(number, at, runId, SPLIT_PICKUP);
  if (doc === null) {
    emit({ path: 'idle', item: null, url: '', filed: [] });
    return;
  }
  const issue = viewIssue(doc.subject);
  const dir = join(artifactsDir(), 'split');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prd.md'), `# ${issue.title}\n\n${issue.url}, now.\n\n${issue.body}\n`);
  emit({
    path: issue.state === 'closed' ? 'closed' : 'slice',
    item: doc.subject,
    url: issue.url,
    filed: doc.facts.split?.issues ?? [],
  });
}

try {
  main();
} catch (error) {
  refuse(`split facts: ${error instanceof Error ? error.message : String(error)}`);
}
