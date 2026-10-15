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
