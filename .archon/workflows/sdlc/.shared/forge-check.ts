/**
 * The early refusal for a run whose forge plugin cannot act: the first node of each
 * workflow that spends on agents before its first forge operation calls this.
 *
 * Without it, a run whose plugin or token is missing implements and reviews before
 * the pull-request write refuses. The operations themselves still refuse on their
 * own; this only moves the first refusal ahead of the spend.
 */

import { invokeForge } from './forge.ts';
import { remoteRepos } from './remote.ts';

export const REQUIRED_FORGE_OPERATIONS = [
  'pr.view',
  'pr.create',
  'pr.edit-body',
  'pr.ready',
  'pr.draft',
  'comment.upsert',
  'checks.state',
  'checks.rerun',
  'workitem.view',
  'repo.labels.list',
  'repo.label.ensure',
  'workitem.comment.upsert',
  'workitem.close',
  'workitem.create',
  'workitem.edit-body',
  'workitem.label.add',
  'workitem.label.remove',
  'pr.threads',
  'pr.thread.reply',
  'pr.thread.resolve',
] as const;

/**
 * `archon forge check`, then one authenticated read, per repository a remote names. The
 * publish target is decided later, by an agent, but it is always a repository some
 * remote names, so one answer is enough; a mirror on a host no plugin claims must not
 * refuse a run its canonical remote can serve.
 *
 * The check answers for the plugin, every delivery operation and the credential without
 * contacting the forge. The read is `pr.view` by head, which answers null when no open
 * pull request has that head, so any head proves the token reads the repository. No
 * forge operation reports what the token may write, so write access is first proven by
 * the run's first write.
 */
export function checkForgeAccess(): string {
  const repos = remoteRepos();
  if (repos.length === 0) {
    throw new Error('this checkout has no git remote that names a forge repository');
  }
  const answered: string[] = [];
  const failures: string[] = [];
  for (const repo of repos) {
    const name = `${repo.host}/${repo.path}`;
    try {
      const source = invokeForge('check', { host: repo.host, operations: REQUIRED_FORGE_OPERATIONS })?.credentialSource;
      invokeForge('pr.view', { selector: { kind: 'head', repo, headRepo: repo, head: 'archon-forge-check' } });
      answered.push(name + (typeof source === 'string' ? ` (source: ${source})` : ''));
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (answered.length === 0) throw new Error(failures.join('\n'));
  return (
    `forge answered for ${answered.join(', ')}` +
    (failures.length === 0 ? '' : `; did not answer for ${failures.join('; ')}`) +
    '. Read access is verified; write access is not, until the first write.'
  );
}
