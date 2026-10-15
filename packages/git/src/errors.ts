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
    const stderr =
      cause instanceof Error && 'stderr' in cause && typeof cause.stderr === 'string'
        ? cause.stderr
        : undefined;
    const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
    super(
      `${message}${typeof code === 'number' ? ` (exit code ${code})` : ''}${stderr && !message.includes(stderr) ? `\n${stderr}` : ''}`,
      { cause }
    );
    this.name = 'GitFailure';
    if (cause instanceof Error) {
      if ('code' in cause && (typeof cause.code === 'string' || typeof cause.code === 'number'))
        this.code = cause.code;
      if ('stderr' in cause && typeof cause.stderr === 'string') this.stderr = cause.stderr;
      if ('stdout' in cause && typeof cause.stdout === 'string') this.stdout = cause.stdout;
      if ('killed' in cause && typeof cause.killed === 'boolean') this.killed = cause.killed;
      if ('signal' in cause && typeof cause.signal === 'string') this.signal = cause.signal;
    }
  }
}
