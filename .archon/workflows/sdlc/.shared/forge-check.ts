/**
 * The early refusal for a run whose forge source cannot act: the first node of each
 * workflow that spends on agents before its first forge operation calls this.
 *
 * Without it, a run whose plugin or token is missing implements and reviews before
 * the pull-request write refuses. The operations themselves still refuse on their
 * own; this only moves the first refusal ahead of the spend.
 */

import { archonCommand, forgeSource, invokeForge, type ForgeSource, type QualifiedPr } from './forge.ts';
import { note } from './io.ts';
import { remoteRepos } from './remote.ts';

/**
 * The read that proves a repository's forge access. `archon doctor` makes the same
 * read; doctor.test.ts holds the two together.
 */
export function forgeAccessRead(repo: QualifiedPr['repo']) {
  return {
    op: 'pr.view',
    data: { selector: { kind: 'head', repo, headRepo: repo, head: 'archon-forge-check' } },
  } as const;
}

export function checkForgeAccess(): { readonly source: ForgeSource } {
  const source = forgeSource();
  if (source === 'gh') checkGh();
  else checkForge();
  return { source };
}

function checkGh(): void {
  // Per-user GitHub mode hands an unconnected user's run empty `GH_TOKEN` and
  // `GITHUB_TOKEN`. gh reads an empty token as unset and falls back to `GITHUB_TOKEN`,
  // then to the host's stored login, so without this refusal the run would push and
  // write as the host's identity. An empty `GH_TOKEN=` line in an env file looks the
  // same when no `GITHUB_TOKEN` is set, so the refusal names both causes.
  if (process.env.GH_TOKEN === '' && !process.env.GITHUB_TOKEN) {
    throw new Error(
      'ARCHON_SDLC_FORGE=gh selects the GitHub CLI, but GH_TOKEN is set and empty and GITHUB_TOKEN is unset, so gh would act as ' +
        "the host's stored login. If an env file has an empty `GH_TOKEN=` line (the Docker `.env` starts " +
        'with one), remove it to use the `gh auth login` login. If per-user GitHub is enabled, the user ' +
        'who started this run has not connected their identity: connect it with `archon auth github`, ' +
        '`/archon connect github` in Slack, or the Web UI Settings page'
    );
  }
  // A bare `gh auth status` fails when any account on any host is stale, so only the active
  // account of each host a remote names is checked, and one working host is enough, as on the
  // forge path.
  const hosts = [...new Set(remoteRepos().map(repo => repo.host))];
  if (hosts.length === 0) {
    throw new Error('this checkout has no git remote that names a forge repository');
  }
  const failures: string[] = [];
  for (const host of hosts) {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync(['gh', 'auth', 'status', '--active', '--hostname', host], { stdout: 'pipe', stderr: 'pipe' });
    } catch (error) {
      throw new Error(
        `ARCHON_SDLC_FORGE=gh selects the GitHub CLI, which could not start (${error instanceof Error ? error.message : String(error)}); ` +
          'install gh, or unset ARCHON_SDLC_FORGE to use the forge plugin'
      );
    }
    if (result.exitCode === 0) return;
    failures.push(`${host}: ${result.stderr?.toString().trim()}`);
  }
  throw new Error(
    `ARCHON_SDLC_FORGE=gh selects the GitHub CLI, which is not authenticated for any host a remote names:\n${failures.join('\n')}\n` +
      'run `gh auth login --hostname <host>`, or unset ARCHON_SDLC_FORGE to use the forge plugin'
  );
}

/**
 * One authenticated read per repository a remote names. The publish target is decided
 * later, by an agent, but it is always a repository some remote names, so one answer
 * is enough; a mirror on a host no plugin claims must not refuse a run its canonical
 * remote can serve.
 *
 * The read is `pr.view` by head, which every released GitHub plugin supports. It
 * answers null when no open pull request has that head, so any head proves the
 * plugin, the token and read access. No forge operation reports what the token may
 * write, so write access is first proven by the run's first write.
 */
function checkForge(): void {
  // A host that published no command (a container execution) refuses once here, not
  // once per repository. A container receives only the project's configured env, never
  // Archon's env file, so the gh switch has to go through the repository config.
  try {
    archonCommand();
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. ` +
        'To use the GitHub CLI in a container execution, set `env: { ARCHON_SDLC_FORGE: gh }` ' +
        "in the repository's `.archon/config.yaml`; Archon's env file does not reach the container"
    );
  }
  const repos = remoteRepos();
  if (repos.length === 0) {
    throw new Error('this checkout has no git remote that names a forge repository');
  }
  const answered: string[] = [];
  const failures: string[] = [];
  for (const repo of repos) {
    const name = `${repo.host}/${repo.path}`;
    try {
      const read = forgeAccessRead(repo);
      invokeForge(read.op, read.data);
      answered.push(name);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (answered.length === 0) throw new Error(failures.join('\n'));
  note(
    `forge source answered for ${answered.join(', ')}` +
      (failures.length === 0 ? '' : `; did not answer for ${failures.join('; ')}`) +
      '. Read access is verified; write access is not, until the first write.'
  );
}
