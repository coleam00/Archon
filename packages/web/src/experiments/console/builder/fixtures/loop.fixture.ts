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

/**
 * Command-backed loop fixture: the per-iteration prompt comes from a command
 * file (`loop.command`), the exactly-one alternative to `loop.prompt`. No
 * `prompt` key may appear anywhere in the round-trip of this fixture.
 */
export const loopCommandFixture: WireWorkflowDefinition = {
  name: 'loop-command-fixture',
  description: 'Iterates a command-file prompt until COMPLETE.',
  nodes: [
    {
      id: 'refine-cmd',
      loop: {
        command: 'refine-draft',
        until: 'COMPLETE',
        max_iterations: 5,
        fresh_context: false,
      },
    },
  ],
};
