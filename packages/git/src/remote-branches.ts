import { execFileAsync } from './exec';
import { gitCredentialOptions, sanitizeGitError } from './credentials';
import { validateCloneUrl, type CloneCredentials } from './repo';
import { toBranchName, type BranchName, type RepoPath } from './types';

export type RemoteBranchTarget =
  | { kind: 'local'; repoPath: RepoPath; remote: string }
  | { kind: 'url'; url: string; credentials?: CloneCredentials };
export type RemoteBranches =
  | { status: 'available'; defaultBranch: BranchName | null; branches: BranchName[] }
  | { status: 'unavailable'; evidence: string };

export class ConfiguredBaseBranchNotFoundError extends Error {
  constructor(branch: string, remote: string) {
    super(
      `Configured base branch '${branch}' not found on remote '${remote}'. ` +
        'Either create the branch, update worktree.baseBranch in .archon/config.yaml, ' +
        'or remove the setting to use the auto-detected default branch.'
    );
    this.name = 'ConfiguredBaseBranchNotFoundError';
  }
}

export class InvalidBaseBranchError extends Error {
  constructor(branch: string) {
    super(`Invalid base branch '${branch}'`);
    this.name = 'InvalidBaseBranchError';
  }
}

export async function validateBranchName(branch: string): Promise<void> {
  if (!branch.trim() || branch !== branch.trim() || branch.startsWith('-'))
    throw new InvalidBaseBranchError(branch);
  try {
    const { stdout } = await execFileAsync('git', ['check-ref-format', '--branch', branch], {
      timeout: 10000,
    });
    if (stdout.trim() !== branch) throw new InvalidBaseBranchError(branch);
  } catch (error) {
    const err = error as Error & { code?: string | number };
    if (err.code === 128 || err.code === 1) throw new InvalidBaseBranchError(branch);
    throw error;
  }
}

/** Read the remote advertisement, so a renamed default never depends on cached remote HEAD. */
export async function inspectRemoteBranches(target: RemoteBranchTarget): Promise<RemoteBranches> {
  let prefix: string[];
  let source: string;
  let credentials: CloneCredentials | undefined;
  let httpUrl: URL | null = null;
  if (target.kind === 'local') {
    await execFileAsync('git', ['-C', target.repoPath, 'rev-parse', '--git-dir'], {
      timeout: 10000,
    });
    prefix = ['-C', target.repoPath];
    source = target.remote;
  } else {
    const validated = validateCloneUrl(target.url);
    if (!validated.ok) throw new Error(validated.error);
    prefix = [];
    source = validated.url;
    httpUrl = validated.httpUrl;
    credentials = target.credentials;
  }
  const { args, env } = gitCredentialOptions(httpUrl, credentials);
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        ...prefix,
        ...args,
        'ls-remote',
        '--symref',
        '--quiet',
        '--',
        source,
        'HEAD',
        'refs/heads/*',
      ],
      { timeout: 10000, env }
    );
    let head: string | null = null;
    let hasHeadCommit = false;
    const branches: BranchName[] = [];
    for (const line of stdout.split('\n')) {
      const [value, ref] = line.split('\t');
      if (ref === 'HEAD') {
        if (value.startsWith('ref: refs/heads/')) head = value.slice('ref: refs/heads/'.length);
        else if (/^[0-9a-f]+$/.test(value)) hasHeadCommit = true;
      } else if (ref?.startsWith('refs/heads/') && /^[0-9a-f]+$/.test(value)) {
        branches.push(toBranchName(ref.slice('refs/heads/'.length)));
      }
    }
    return {
      status: 'available',
      defaultBranch: head && hasHeadCommit ? toBranchName(head) : null,
      branches,
    };
  } catch (error) {
    const err = error as Error & { code?: string | number; killed?: boolean };
    if (typeof err.code !== 'number' && !err.killed) throw error;
    return { status: 'unavailable', evidence: sanitizeGitError(error, credentials) };
  }
}
