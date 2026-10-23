export type GitFailureKind =
  | 'timeout'
  | 'unclassified'
  | 'not_repository'
  | 'adoption_refused'
  | 'different_clone'
  | 'ownership_unverified'
  | 'default_branch_missing';

export class GitFailure extends Error {
  readonly code?: string | number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly killed?: boolean;
  readonly signal?: string;

  constructor(
    readonly kind: GitFailureKind,
    message: string,
    cause?: unknown
  ) {
    super(gitFailureMessage(message, cause), { cause });
    this.name = 'GitFailure';
    Object.assign(this, gitFailureEvidence(cause));
  }
}

function gitFailureMessage(message: string, cause: unknown): string {
  const stderr =
    cause instanceof Error && 'stderr' in cause && typeof cause.stderr === 'string'
      ? cause.stderr
      : undefined;
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return `${message}${typeof code === 'number' ? ` (exit code ${code})` : ''}${stderr && !message.includes(stderr) ? `\n${stderr}` : ''}`;
}

function gitFailureEvidence(
  cause: unknown
): Pick<GitFailure, 'code' | 'stderr' | 'stdout' | 'killed' | 'signal'> {
  if (!(cause instanceof Error)) return {};
  return {
    ...('code' in cause && (typeof cause.code === 'string' || typeof cause.code === 'number')
      ? { code: cause.code }
      : {}),
    ...('stderr' in cause && typeof cause.stderr === 'string' ? { stderr: cause.stderr } : {}),
    ...('stdout' in cause && typeof cause.stdout === 'string' ? { stdout: cause.stdout } : {}),
    ...('killed' in cause && typeof cause.killed === 'boolean' ? { killed: cause.killed } : {}),
    ...('signal' in cause && typeof cause.signal === 'string' ? { signal: cause.signal } : {}),
  };
}
