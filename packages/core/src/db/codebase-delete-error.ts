export class ActiveContainerEnvironmentsError extends Error {
  constructor(readonly environmentIds: readonly string[]) {
    super(
      `Active container environments remain: ${environmentIds.join(', ')}. ` +
        'Run `archon isolation cleanup 0` to clean eligible containers, then retry deletion. ' +
        'Containers owned by resumable runs must be released before cleanup.'
    );
    this.name = 'ActiveContainerEnvironmentsError';
  }
}

export class ActiveWorktreeEnvironmentsError extends Error {
  constructor(readonly environmentIds: readonly string[]) {
    super(
      `Active worktree environments remain: ${environmentIds.join(', ')}. ` +
        'Project kept. Retry deletion to clean up these worktrees.'
    );
    this.name = 'ActiveWorktreeEnvironmentsError';
  }
}

export { WorktreeRegistrationChangedError } from '@archon/isolation/types';
