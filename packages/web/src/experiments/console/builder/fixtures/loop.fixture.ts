/**
 * Loop-variant fixture. Exercises the full loop field surface (prompt, until,
 * max_iterations, fresh_context, until_bash, interactive, gate_message).
 * Authored already-sparse — exactly as the engine transform would emit.
 */
import type { WireWorkflowDefinition } from '../types';

export const loopFixture: WireWorkflowDefinition = {
  name: 'loop-fixture',
  description: 'Iterates until the work reports COMPLETE.',
  nodes: [
    {
      id: 'refine',
      loop: {
        prompt: 'Refine the draft. Emit COMPLETE when no further changes are needed.',
        until: 'COMPLETE',
        max_iterations: 5,
        fresh_context: false,
        until_bash: 'test -f ./done.flag',
        interactive: true,
        gate_message: 'Review the latest draft before continuing.',
      },
    },
  ],
};
