import { describe, test } from 'bun:test';

describe('workflow retry preparation operation', () => {
  test.todo('rejects retry when the run is not failed or the target node is not failed', () => {});
  test.todo(
    'increments retry metadata exactly once while moving the same run back to running',
    () => {}
  );
  test.todo(
    'filters preserved outputs to exclude invalidated target and descendant nodes',
    () => {}
  );
  test.todo('deletes persisted node sessions for every invalidated node before dispatch', () => {});
  test.todo('writes retry audit events through the strict retry audit writer', () => {});
  test.todo('restores failed status and avoids dispatch when retry preparation fails', () => {});
});
