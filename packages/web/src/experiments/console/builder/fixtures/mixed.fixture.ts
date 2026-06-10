/**
 * Mixed multi-node fixture. A small DAG with `depends_on` edges, a `when:`
 * expression, workflow-level meta, and a spread of variants and base fields.
 * Authored already-sparse.
 */
import type { WireWorkflowDefinition } from '../types';

export const mixedFixture: WireWorkflowDefinition = {
  name: 'mixed-fixture',
  description: 'Classify, branch on the result, and finish.',
  provider: 'claude',
  model: 'sonnet',
  tags: ['triage', 'demo'],
  nodes: [
    {
      id: 'classify',
      prompt: 'Classify the issue as BUG or FEATURE. Reply with one word.',
      output_type: 'classification',
    },
    {
      id: 'fix',
      depends_on: ['classify'],
      when: "$classify.output == 'BUG'",
      command: 'implement-fix',
      model: 'opus',
      persist_session: true,
    },
    {
      id: 'report',
      depends_on: ['classify', 'fix'],
      trigger_rule: 'all_done',
      bash: "echo 'done: $classify.output'",
      timeout: 15000,
    },
  ],
};
