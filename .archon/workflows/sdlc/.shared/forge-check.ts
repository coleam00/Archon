/**
 * The early refusal for a run whose forge plugin cannot act: the first node of each
 * workflow that spends on agents before its first forge operation calls this.
 *
 * Without it, a run whose plugin or token is missing implements and reviews before
 * the pull-request write refuses. The operations themselves still refuse on their
 * own; this only moves the first refusal ahead of the spend.
 */

import { ForgeError, type ForgeOperations, forge } from 'archon:script';
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

/** The GitHub forge plugin install id. */
const GITHUB_FORGE_PLUGIN = 'coleam00/Archon/plugins/forge-github';

// Per-user GitHub mode scrubs the shared token from a run started by a user who has
// not connected their own identity, so a shared `GH_TOKEN` cannot fix that refusal.
const SETUP =
  'The SDLC pack reaches the forge through a forge plugin. For github.com, install it with ' +
  `\`archon plugin add ${GITHUB_FORGE_PLUGIN}\`, and set \`GH_TOKEN\` in ` +
  "Archon's env file (`~/.archon/.env`, `ARCHON_HOME/.env` when configured, or `/.archon/.env` in Docker), " +
  'set `GITHUB_TOKEN`, use `gh auth login`, or configure GitHub App mode. When per-user GitHub ' +
  'is enabled, connect your own GitHub identity instead of setting `GH_TOKEN`: ' +
  '`archon auth github` or the Web UI Settings page.';

/** The operator's next step for each refusal that is their setup's, by the failure's `kind`. */
const REMEDY: Partial<Record<ForgeError['kind'], string>> = {
  no_plugin_for_host: SETUP,
  no_credential: SETUP,
  unsupported_op:
    `For github.com, \`archon plugin update ${GITHUB_FORGE_PLUGIN}\` installs the ` +
    'latest released plugin, which may not support this operation either.',
};

/**
 * `archon forge check`: the host's plugin, these operations and its credential, without
 * contacting the forge. Returns the credential's source; a refusal that is the operator's
 * setup's names their next step.
 */
export function requireForge(host: string, operations: readonly (keyof ForgeOperations)[]): string | undefined {
  try {
    return forge('check', { host, operations }).credentialSource;
  } catch (error) {
    const remedy = error instanceof ForgeError ? REMEDY[error.kind] : undefined;
    if (remedy === undefined) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${remedy}`);
  }
}

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
      const source = requireForge(repo.host, REQUIRED_FORGE_OPERATIONS);
      forge('pr.view', { selector: { kind: 'head', repo, headRepo: repo, head: 'archon-forge-check' } });
      answered.push(name + (source === undefined ? '' : ` (source: ${source})`));
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
