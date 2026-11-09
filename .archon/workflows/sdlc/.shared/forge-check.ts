/**
 * The early refusal for a run whose forge plugin cannot act: the first node of each
 * workflow that spends on agents before its first forge operation calls this.
 *
 * Without it, a run whose plugin or token is missing implements and reviews before
 * the pull-request write refuses. The operations themselves still refuse on their
 * own; this only moves the first refusal ahead of the spend.
 */

import { archonCommand, GITHUB_FORGE_PLUGIN, invokeForge, type QualifiedPr } from './forge.ts';
import { remoteRepos } from './remote.ts';

export function forgeAccessRead(repo: QualifiedPr['repo']) {
  return {
    op: 'pr.view',
    data: { selector: { kind: 'head', repo, headRepo: repo, head: 'archon-forge-check' } },
  } as const;
}

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


export interface ForgeProbe {
  (
    op: string,
    data: Record<string, unknown>
  ): Promise<{
    value: Record<string, unknown> | null;
    credentialSource?: string;
  }>;
}

const probeForge: ForgeProbe = async (op, data) => {
  // A container execution has no host command, so the pack cannot reach the forge there.
  archonCommand();
  let credentialSource: string | undefined;
  const value = invokeForge(op, data, source => {
    credentialSource = source;
  });
  return { value, credentialSource };
};

function requirePackOperations(metadata: Record<string, unknown> | null): void {
  const capabilities = metadata?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every(op => typeof op === 'string'))
    throw new Error('forge metadata returned no operation capabilities');
  const missing = REQUIRED_FORGE_OPERATIONS.filter(op => !capabilities.includes(op));
  if (missing.length)
    throw new Error(
      `the SDLC pack needs a forge plugin with every delivery operation; missing: ${missing.join(', ')}. ` +
        `The GitHub plugin has every one from v0.13.0: \`archon plugin update ${GITHUB_FORGE_PLUGIN}\`.`
    );
}

/**
 * One authenticated read per repository a remote names. The publish target is decided
 * later, by an agent, but it is always a repository some remote names, so one answer
 * is enough; a mirror on a host no plugin claims must not refuse a run its canonical
 * remote can serve.
 *
 * Metadata must advertise every delivery operation before the read runs. The read
 * is `pr.view` by head, which answers null when no open PR has that head. Any
 * head therefore proves the
 * plugin, the token and read access. No forge operation reports what the token may
 * write, so write access is first proven by the run's first write.
 */
export async function checkForgeAccess(probe: ForgeProbe = probeForge): Promise<string> {
  const repos = remoteRepos();
  if (repos.length === 0) {
    throw new Error('this checkout has no git remote that names a forge repository');
  }
  const answered: string[] = [];
  const failures: string[] = [];
  for (const repo of repos) {
    const name = `${repo.host}/${repo.path}`;
    try {
      requirePackOperations((await probe('metadata', { host: repo.host })).value);
      const read = forgeAccessRead(repo);
      const { credentialSource } = await probe(read.op, read.data);
      answered.push(name + (credentialSource ? ` (source: ${credentialSource})` : ''));
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
