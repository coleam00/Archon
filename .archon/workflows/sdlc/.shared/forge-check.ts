/**
 * The early refusal for a run whose forge source cannot act: the first node of each
 * workflow that spends on agents before its first forge operation calls this.
 *
 * Without it, a run whose plugin or token is missing implements and reviews before
 * the pull-request write refuses. The operations themselves still refuse on their
 * own; this only moves the first refusal ahead of the spend.
 */

import {
  archonCommand,
  forgeSource,
  invokeForge,
  type ForgeSource,
  type QualifiedPr,
} from './forge.ts';
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
  'workitem.labels.set',
  'workitem.comment.upsert',
  'workitem.close',
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
  // A container receives only the project's configured env, never Archon's env file,
  // so the gh switch has to go through the repository config.
  try {
    archonCommand();
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. ` +
        'To use the GitHub CLI in a container execution, set `env: { ARCHON_SDLC_FORGE: gh }` ' +
        "in the repository's `.archon/config.yaml`; Archon's env file does not reach the container"
    );
  }
  let credentialSource: string | undefined;
  const value = invokeForge(op, data, source => {
    credentialSource = source;
  });
  return { value, credentialSource };
};

export async function checkForgeAccess(
  env: NodeJS.ProcessEnv = process.env,
  probe: ForgeProbe = probeForge
): Promise<{ readonly source: ForgeSource; readonly detail: string }> {
  const source = forgeSource(env);
  const detail = source === 'gh' ? await checkGh(env, probe) : await checkForge(probe);
  return { source, detail };
}

async function ghRemedy(probe: ForgeProbe): Promise<string> {
  const login = 'run `gh auth login --hostname <host>`, or set GH_TOKEN or GITHUB_TOKEN';
  for (const repo of remoteRepos()) {
    try {
      requirePackOperations((await probe('metadata', { host: repo.host })).value);
      return (
        login + ', or set ARCHON_SDLC_FORGE=forge to use the installed compatible forge plugin'
      );
    } catch {
      // An optional alternative must not hide the selected gh source's refusal.
    }
  }
  return login;
}

function requirePackOperations(metadata: Record<string, unknown> | null): void {
  const capabilities = metadata?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every(op => typeof op === 'string'))
    throw new Error('forge metadata returned no operation capabilities');
  const missing = REQUIRED_FORGE_OPERATIONS.filter(op => !capabilities.includes(op));
  if (missing.length)
    throw new Error(
      `ARCHON_SDLC_FORGE=forge needs a plugin with every pack operation; missing: ${missing.join(', ')}. ` +
        'The released GitHub plugin v0.11.1 is insufficient. Use ARCHON_SDLC_FORGE=gh until a compatible release is installed.'
    );
}

async function checkGh(env: NodeJS.ProcessEnv, probe: ForgeProbe): Promise<string> {
  // A bare `gh auth status` fails when any account on any host is stale, so only the active
  // account of each host a remote names is checked, and one working host is enough, as on the
  // forge path.
  const hosts = [...new Set(remoteRepos().map(repo => repo.host))];
  if (hosts.length === 0) {
    throw new Error('this checkout has no git remote that names a forge repository');
  }
  const failures: string[] = [];
  for (const host of hosts) {
    const tokenNames =
      host === 'github.com' || host.endsWith('.ghe.com')
        ? ['GH_TOKEN', 'GITHUB_TOKEN']
        : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
    // Empty host-specific credentials mark a scrubbed identity. gh otherwise
    // treats them as unset and falls back to the host's stored login.
    if (tokenNames.some(name => env[name] === '') && !tokenNames.some(name => env[name])) {
      failures.push(
        `${host}: ${tokenNames.join(' or ')} is set and empty, so gh would act as ` +
          `the host's stored login. Remove an empty \`${tokenNames[0]}=\` line from an env file to use ` +
          '`gh auth login`. If per-user GitHub is enabled, connect it with `archon auth github`, ' +
          '`/archon connect github` in Slack, or the Web UI Settings page'
      );
      continue;
    }
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync(['gh', 'auth', 'status', '--active', '--hostname', host], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      throw new Error(
        `ARCHON_SDLC_FORGE=gh selects the GitHub CLI, which could not start (${error instanceof Error ? error.message : String(error)}); ` +
          `install gh; ${await ghRemedy(probe)}`
      );
    }
    if (result.exitCode === 0) {
      const credentialSource = tokenNames.find(name => env[name]) ?? 'gh auth login';
      return (
        `gh authenticated for ${host} (source: ${credentialSource})` +
        (failures.length === 0 ? '' : `; did not authenticate for ${failures.join('; ')}`)
      );
    }
    failures.push(`${host}: ${result.stderr?.toString().trim()}`);
  }
  throw new Error(
    `ARCHON_SDLC_FORGE=gh selects the GitHub CLI, which is not authenticated for any host a remote names:\n${failures.join('\n')}\n` +
      (await ghRemedy(probe))
  );
}

/**
 * One authenticated read per repository a remote names. The publish target is decided
 * later, by an agent, but it is always a repository some remote names, so one answer
 * is enough; a mirror on a host no plugin claims must not refuse a run its canonical
 * remote can serve.
 *
 * Metadata must advertise every pack operation before the read runs. The read
 * is `pr.view` by head, which answers null when no open PR has that head. Any
 * head therefore proves the
 * plugin, the token and read access. No forge operation reports what the token may
 * write, so write access is first proven by the run's first write.
 */
async function checkForge(probe: ForgeProbe): Promise<string> {
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
    `forge source answered for ${answered.join(', ')}` +
    (failures.length === 0 ? '' : `; did not answer for ${failures.join('; ')}`) +
    '. Read access is verified; write access is not, until the first write.'
  );
}
