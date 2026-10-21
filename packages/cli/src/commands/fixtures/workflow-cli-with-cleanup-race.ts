import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as isolation from '@archon/core/db/isolation-environments';

const acquire = isolation.withWorktreeRegistration;
mock.module('@archon/core/db/isolation-environments', () => ({
  ...isolation,
  withWorktreeRegistration: ((observed, remove, releaseFailed) => {
    writeFileSync(join(observed.working_path, 'arrived.txt'), 'work arriving after assessment');
    return acquire(observed, remove, releaseFailed);
  }) satisfies typeof isolation.withWorktreeRegistration,
}));
await import('./workflow-cli-without-title');
