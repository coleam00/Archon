/**
 * Claim the split queue's next item and write the issue the slice agent splits.
 *
 * It claims the waiting item that sorts first in intake's order, or the item the
 * `number` input names, and writes nothing else. A named item that cannot
 * be claimed refuses the run with the reason. A closed issue goes to `closed`, which
 * publish records without an agent. The issues already filed from the item come from
 * its work item, where publish records each one as it files it, and so does triage's
 * summary of why building the item whole would not work, from the history entry of
 * the intake run that routed it `split`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, refuse, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { filedIssues, SPLIT_PICKUP } from '../../.shared/split.ts';
import { claimNamed, claimNext } from '../../.shared/workitem.ts';

function main(): void {
  const named = trimmed(process.env.INPUTS_NUMBER);
  const number = Number(named);
  if (named !== '' && (!Number.isInteger(number) || number <= 0)) throw new Error('number must be a positive integer');
  const doc = named === '' ? claimNext(SPLIT_PICKUP) : claimNamed(number, SPLIT_PICKUP);
  if (doc === null) {
    emit({ path: 'idle', item: null, url: '', filed: [], reason: '' });
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
    filed: filedIssues(doc.facts.split),
    reason: [...doc.history].reverse().find(entry => entry.stage === 'intake' && entry.outcome === 'split')?.summary ?? '',
  });
}

try {
  main();
} catch (error) {
  refuse(`split facts: ${error instanceof Error ? error.message : String(error)}`);
}
