---
paths:
  - "packages/workflows/**/*.ts"
  - ".archon/workflows/**/*.yaml"
  - ".archon/commands/**/*.md"
---

# Workflows Conventions

## DAG Workflow Format

All workflows use the DAG (Directed Acyclic Graph) format with `nodes:`. Loop nodes are supported as a node type within DAGs.

```yaml
nodes:
  - id: classify
    prompt: "Is this a bug or feature? Answer JSON: {type: 'BUG'|'FEATURE'}"
    output_format: {type: object, properties: {type: {type: string}}}
  - id: implement
    command: execute
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
  - id: run_lint
    bash: "bun run lint"
    depends_on: [implement]
  - id: iterate
    loop:
      until: "COMPLETE"
      max_iterations: 10
    prompt: "Iterate until the tests pass. Signal COMPLETE when done."
    depends_on: [run_lint]
```

## Variable Substitution

| Variable | Resolved to |
|----------|-------------|
| `$1`, `$2`, `$3` | Positional arguments from user message |
| `$ARGUMENTS` | All user arguments as single string |
| `$ARTIFACTS_DIR` | Pre-created external artifacts directory |
| `$WORKFLOW_ID` | Current workflow run ID |
| `$BASE_BRANCH` | Base branch from config or auto-detected |
| `$DOCS_DIR` | Documentation directory path (default: `docs/`) |
| `$nodeId.output` | Captured stdout/AI output from completed DAG node |

## WorkflowDeps — Dependency Injection

`@archon/workflows` has ZERO `@archon/core` dependency. Everything is injected:

```typescript
interface WorkflowDeps {
  store: IWorkflowStore;                           // DB abstraction
  getAgentProvider: AgentProviderFactory;           // Returns IAgentProvider by provider id
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
}

// Core creates the adapter:
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
const deps = createWorkflowDeps();
await executeWorkflow(deps, platform, conversationId, cwd, workflow, ...);
```

## DAG Node Types

- `command:` — named file from `.archon/commands/`, AI-executed
- `prompt:` — inline prompt string, AI-executed
- `bash:` — shell script, no AI; stdout captured as `$nodeId.output`; default timeout 120000ms
- `script:` — inline code or named file from `.archon/scripts/`, runs via `runtime: bun` (`.ts`/`.js`) or `runtime: uv` (`.py`), no AI; stdout captured as `$nodeId.output`; supports `deps:` for dependency installation and `timeout:` (ms); runtime availability checked at load time with a warning if binary is missing

DAG node options: `depends_on`, `when` (condition expression), `trigger_rule` (`all_success` | `one_success` | `none_failed_min_one_success` | `all_done`), `output_format` (JSON Schema, Claude only), `allowed_tools` / `denied_tools` (Claude only), `idle_timeout` (ms), `context: 'fresh'`, per-node `provider` and `model`, `deps` (script nodes only — dependency list), `runtime` (script nodes only — `'bun'` or `'uv'`).

## Event Emitter for Observability

```typescript
import { getWorkflowEventEmitter } from '@archon/workflows';

const emitter = getWorkflowEventEmitter();
emitter.registerRun(runId, conversationId);

// Subscribe (returns unsubscribe fn)
const unsubscribe = emitter.subscribeForConversation(conversationId, (event) => {
  // event.type: 'step_started' | 'step_completed' | 'node_started' | ...
});
```

Listener errors never propagate to the executor — fire-and-forget with internal catch.

## Architecture

- Model validation at load time — invalid provider/model combinations fail `parseWorkflow()` with clear error
- Resilient discovery — one broken YAML doesn't abort `discoverWorkflows()`; errors returned in `WorkflowLoadResult.errors`
- Bundled defaults embedded in binary builds; loaded from filesystem in source builds
- Repo workflows override bundled defaults by name
- Router fallback: if no `/invoke-workflow` produced → falls back to `archon-assist`; raw AI response only when `archon-assist` unavailable

## Anti-patterns

- Never import `@archon/core` from `@archon/workflows` (circular dependency)
- Never add `clearContext: true` to every step — context continuity is valuable; use sparingly
- Never put `output_format` on Codex nodes — it logs a warning and is ignored
- Never set `allowed_tools: undefined` expecting "no tools" — use `allowed_tools: []` for that
