/**
 * Script-variant fixture. Exercises script body, runtime, deps, and timeout.
 * Authored already-sparse.
 */
import type { WireWorkflowDefinition } from '../types';

export const scriptFixture: WireWorkflowDefinition = {
  name: 'script-fixture',
  description: 'Runs an inline TypeScript script via bun.',
  nodes: [
    {
      id: 'analyze',
      script:
        "import { z } from 'zod';\nprocess.stdout.write(String(z.string().safeParse('ok').success));",
      runtime: 'bun',
      deps: ['zod'],
      timeout: 30000,
    },
  ],
};
