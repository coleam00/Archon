/**
 * The early refusal for a run whose forge source cannot act: the first node of each
 * workflow that spends on agents before its first forge operation calls this.
 *
 * Without it, a run whose plugin or token is missing implements and reviews before
 * the pull-request write refuses. The operations themselves still refuse on their
 * own; this only moves the first refusal ahead of the spend.
 */

import { archonCommand, forgeSource, readRepositoryLabels, type ForgeSource } from './forge.ts';
import { note } from './io.ts';
import { remoteRepos } from './remote.ts';

export function checkForgeAccess(): { readonly source: ForgeSource } {
  const source = forgeSource();
  if (source === 'gh') checkGh();
  else checkForge();
  return { source };
}

function checkGh(): void {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(['gh', 'auth', 'status'], { stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    throw new Error(
      `ARCHON_SDLC_FORGE=gh selects the GitHub CLI, which could not start (${error instanceof Error ? error.message : String(error)}); ` +
        'install gh, or unset ARCHON_SDLC_FORGE to use the forge plugin'
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `ARCHON_SDLC_FORGE=gh selects the GitHub CLI, which is not authenticated: ${result.stderr?.toString().trim()}; ` +
        'run `gh auth login`, or unset ARCHON_SDLC_FORGE to use the forge plugin'
    );
  }
}

/**
 * One authenticated read (`repo.labels.list`, which triage needs anyway) per
 * repository a remote names. The publish target is decided later, by an agent, but
 * it is always a repository some remote names, so one answer is enough; a mirror on
 * a host no plugin claims must not refuse a run its canonical remote can serve.
 */
function checkForge(): void {
  // A host that published no command refuses once here, not once per repository.
  archonCommand();
  const repos = remoteRepos();
  if (repos.length === 0) {
    throw new Error('this checkout has no git remote that names a forge repository');
  }
  const answered: string[] = [];
  const failures: string[] = [];
  for (const repo of repos) {
    const name = `${repo.host}/${repo.path}`;
    try {
      readRepositoryLabels(repo);
      answered.push(name);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (answered.length === 0) throw new Error(failures.join('\n'));
  note(
    `forge source answered for ${answered.join(', ')}` +
      (failures.length === 0 ? '' : `; did not answer for ${failures.join('; ')}`)
  );
}
