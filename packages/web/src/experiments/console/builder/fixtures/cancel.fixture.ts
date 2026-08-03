/**
 * Cancel-variant fixture. A guarded cancel node that terminates the run with a
 * reason when an upstream check fails. Authored already-sparse.
 */
import type { WireWorkflowDefinition } from '../types';

export const cancelFixture: WireWorkflowDefinition = {
  name: 'cancel-fixture',
  description: 'Aborts the run when the precheck reports a blocker.',
  nodes: [
    {
      id: 'precheck',
      bash: 'echo BLOCKED',
    },
    {
      id: 'abort',
      depends_on: ['precheck'],
      when: "$precheck.output == 'BLOCKED'",
      cancel: 'Precheck reported a blocker; aborting the run.',
    },
  ],
};
