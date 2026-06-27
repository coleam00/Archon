/**
 * Test factories for workflow types.
 * Use these instead of inline fixture objects so schema changes update one file.
 */
import { workflowDefinitionSchema } from './schemas/workflow';
import type { WorkflowDefinition, WorkflowWithSource, WorkflowSource } from './schemas/workflow';

const DEFAULT_NODE = { id: 'default', command: 'test-command' };
const DEFAULT_ROUTE_LOOP_IDS: RouteLoopFixtureIds = {
  fix: 'fix',
  review: 'review',
  router: 'review-router',
  done: 'done',
  escalation: 'escalation',
};

type TestWorkflowOverrides = {
  name: string;
  nodes?: unknown[];
} & Partial<Omit<WorkflowDefinition, 'name' | 'nodes'>>;

export type RouteLoopFixtureNodeName = 'fix' | 'review' | 'router' | 'done' | 'escalation';

export type RouteLoopFixtureIds = Record<RouteLoopFixtureNodeName, string>;

export interface RouteLoopFixtureRoutes {
  positive: string;
  negative: string;
  exhausted: string;
}

export interface RouteLoopFixtureConfig {
  from: string;
  condition: string;
  routes: RouteLoopFixtureRoutes;
  max_iterations?: number;
}

export interface RouteLoopPromptFixtureNode {
  id: string;
  prompt: string;
  depends_on?: string[];
  output_format?: Record<string, unknown>;
  output_type?: string;
}

export interface RouteLoopControllerFixtureNode {
  id: string;
  depends_on: string[];
  route_loop: RouteLoopFixtureConfig;
}

export type RouteLoopWorkflowFixtureNode =
  | RouteLoopPromptFixtureNode
  | RouteLoopControllerFixtureNode;

export type RouteLoopWorkflowOverrides = {
  name?: string;
  description?: string;
  ids?: Partial<RouteLoopFixtureIds>;
  condition?: string;
  routes?: Partial<RouteLoopFixtureRoutes>;
  max_iterations?: number;
  nodes?: unknown[];
} & Partial<Omit<WorkflowDefinition, 'name' | 'description' | 'nodes'>>;

export type RouteLoopWorkflowFixture = Omit<WorkflowDefinition, 'nodes'> & { nodes: unknown[] };

export function makeTestWorkflow(overrides: TestWorkflowOverrides): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    description: `${overrides.name} test workflow`,
    nodes: [DEFAULT_NODE],
    ...overrides,
  });
}

export function makeTestWorkflowList(names: string[]): WorkflowDefinition[] {
  return names.map(name => makeTestWorkflow({ name }));
}

export function makeRouteLoopWorkflowNodes(
  overrides: RouteLoopWorkflowOverrides = {}
): RouteLoopWorkflowFixtureNode[] {
  const ids: RouteLoopFixtureIds = { ...DEFAULT_ROUTE_LOOP_IDS, ...overrides.ids };
  const routes: RouteLoopFixtureRoutes = {
    positive: ids.done,
    negative: ids.fix,
    exhausted: ids.escalation,
    ...overrides.routes,
  };
  const routeLoop: RouteLoopFixtureConfig = {
    from: ids.review,
    condition: overrides.condition ?? `$${ids.review}.output.approved == true`,
    routes,
    ...(overrides.max_iterations !== undefined ? { max_iterations: overrides.max_iterations } : {}),
  };

  return [
    {
      id: ids.fix,
      prompt: 'Apply the requested fix and summarize the changes.',
      output_type: 'code',
    },
    {
      id: ids.review,
      depends_on: [ids.fix],
      prompt: 'Review the fix and emit JSON with an approved boolean.',
      output_format: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
        },
        required: ['approved'],
      },
      output_type: 'review',
    },
    {
      id: ids.router,
      depends_on: [ids.review],
      route_loop: routeLoop,
    },
    {
      id: ids.done,
      depends_on: [ids.router],
      prompt: 'Summarize the accepted fix.',
      output_type: 'summary',
    },
    {
      id: ids.escalation,
      depends_on: [ids.router],
      prompt: 'Escalate because the review loop was exhausted.',
      output_type: 'escalation',
    },
  ];
}

export function makeRouteLoopWorkflow(
  overrides: RouteLoopWorkflowOverrides = {}
): RouteLoopWorkflowFixture {
  const {
    nodes,
    ids,
    condition,
    routes,
    max_iterations: maxIterations,
    ...workflowOverrides
  } = overrides;
  void ids;
  void condition;
  void routes;
  void maxIterations;

  return {
    name: 'route-loop-fixture',
    description: 'Fix, review, and route until accepted or exhausted.',
    nodes: nodes ?? makeRouteLoopWorkflowNodes(overrides),
    ...workflowOverrides,
  };
}

/** Wrap a WorkflowDefinition as a WorkflowWithSource entry for test mocks. */
export function makeTestWorkflowWithSource(
  overrides: TestWorkflowOverrides,
  source: WorkflowSource = 'bundled'
): WorkflowWithSource {
  return { workflow: makeTestWorkflow(overrides), source };
}

export function makeRouteLoopWorkflowWithSource(
  overrides: RouteLoopWorkflowOverrides = {},
  source: WorkflowSource = 'bundled'
): { workflow: RouteLoopWorkflowFixture; source: WorkflowSource } {
  return { workflow: makeRouteLoopWorkflow(overrides), source };
}
