/**
 * Route-loop fixture. A review controller routes positive, negative, and
 * exhausted outcomes through already-sparse wire fields.
 */
import type { WireWorkflowDefinition } from '../types';

const routeLoopController = {
  id: 'review_router',
  depends_on: ['review'],
  route_loop: {
    from: 'review',
    condition: "$review.output.status == 'approved'",
    max_iterations: 3,
    routes: {
      positive: 'done',
      negative: 'fix',
      exhausted: 'escalate',
    },
  },
};

export const routeLoopFixture: WireWorkflowDefinition = {
  name: 'route-loop-fixture',
  description: 'Revises until review passes or attempts are exhausted.',
  nodes: [
    {
      id: 'fix',
      prompt: 'Revise the implementation based on the latest review.',
      output_type: 'patch',
    },
    {
      id: 'review',
      depends_on: ['fix'],
      prompt: 'Review the implementation and emit JSON with a status field.',
      output_type: 'review_result',
    },
    routeLoopController,
    {
      id: 'done',
      bash: "echo 'approved'",
    },
    {
      id: 'escalate',
      bash: "echo 'review exhausted'",
    },
  ],
};
