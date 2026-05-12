---
description: Prime agent with Archon workflow engine context
---

# Prime Workflows: Workflow Engine Orientation

## Objective

Orient on the workflow engine (`packages/workflows/`) before working on workflow execution,
YAML parsing, DAG logic, routing, or observability.

## Process

### 1. Understand the Workflow Package Structure

!`ls packages/workflows/src/`

### 2. Understand Workflow Type Definitions

Read `packages/workflows/src/types.ts` in full — the complete type system for workflow
definitions: `WorkflowDefinition`, `WorkflowStep`, `WorkflowNode` (DAG), `LoopConfig`,
`NodeType` (command / prompt / bash), `TriggerRule`, `OutputFormat`, tool restriction fields.

### 3. Understand the Executor

Read `packages/workflows/src/executor.ts` first 80 lines — `executeWorkflow()` entry point,
the three mutually exclusive execution modes (steps, loop, nodes/DAG), artifact directory setup,
variable substitution via `$ARTIFACTS_DIR` / `$WORKFLOW_ID`.

Read `packages/workflows/src/dag-executor.ts` first 80 lines — topological sort, concurrent
node dispatch for independent nodes in the same layer, `when:` condition evaluation,
`trigger_rule` join semantics, `$nodeId.output` substitution.

### 4. Understand the Loader

Read `packages/workflows/src/loader.ts` first 60 lines — `discoverWorkflows()` / `discoverWorkflowsWithConfig()`,
resilient loading (one bad YAML doesn't abort), model validation at load time,
bundled defaults merging with repo-specific workflows.

### 5. Understand the Router

Read `packages/workflows/src/router.ts` first 60 lines — how incoming messages are matched
to workflows, case-insensitive matching, `archon-assist` fallback, Codex tool bypass detection.

### 6. Understand Observability

Read `packages/workflows/src/event-emitter.ts` — `WorkflowEventEmitter`, emitted event types
(step_started, step_completed, node events, loop iterations, artifacts), how the server
bridges these to SSE via `WorkflowEventBridge`.

### 7. Understand Dependency Injection

Read `packages/workflows/src/deps.ts` — `WorkflowDeps` type: `IWorkflowPlatform`,
`IWorkflowAgentProvider`, `IWorkflowStore` injected at runtime. No direct DB or AI imports
inside this package.

### 8. See What Workflows Are Available

List bundled default workflows:
!`ls packages/workflows/src/defaults/`

List repo workflows (if any):
!`ls .archon/workflows/ 2>/dev/null || echo "(none in repo root)"`

### 9. Check Recent Workflow Engine Activity

!`git log -8 --oneline -- packages/workflows/`

## Output

Summarize (under 250 words):

### Execution Modes
- `steps:` — sequential steps, each step is a command or inline prompt
- `loop:` — iterative execution with `max_iterations` and `exit_condition`
- `nodes:` (DAG) — explicit `depends_on` edges, concurrent independent nodes per layer

### DAG Node Types
- `command:` — named command file from `.archon/commands/`
- `prompt:` — inline prompt text
- `bash:` — shell script, stdout captured as `$nodeId.output`, no AI involved

### Key Features
- `when:` conditions, `trigger_rule` join semantics (all / any_success / always)
- `output_format` for structured JSON (Claude only)
- `allowed_tools` / `denied_tools` per node (Claude only)
- Per-node `provider` and `model` overrides
- `$nodeId.output` cross-node data passing

### Variable Substitution
- `$1`, `$2`, `$ARGUMENTS`, `$PLAN`, `$ARTIFACTS_DIR`, `$WORKFLOW_ID`, `$BASE_BRANCH`

### Bundled Workflows
- List the key default workflow names and their purposes

### Recent Changes
