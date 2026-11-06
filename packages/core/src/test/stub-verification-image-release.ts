import { afterAll, mock, spyOn } from 'bun:test';
import * as cleanup from '../services/cleanup/run-verification-images';

export function stubVerificationImageRelease() {
  const createRelease = cleanup.createRunResourceRelease;
  const release = mock(async (_runId: string, _envId?: string) => {});
  const factory = spyOn(cleanup, 'createRunResourceRelease').mockImplementation(store =>
    createRelease(store, release)
  );
  afterAll(() => factory.mockRestore());
  return release;
}
