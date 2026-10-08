export class FileStoreUnsupportedError extends Error {
  constructor(public readonly capability: string) {
    super(`${capability} requires store: database; store: files does not support it.`);
    this.name = 'FileStoreUnsupportedError';
  }
}
