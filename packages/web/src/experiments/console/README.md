# Console

The console is Archon's only shipped Web application. Its historical directory
name remains in place to avoid a mechanical move while the builder is changing.

## Routes

- `/console` → all runs
- `/console/settings` → assistant, provider, system, and identity settings
- `/console/builder` → experimental workflow builder and project picker
- `/console/builder/:name` → edit a project workflow selected by
  `?project=<id>`
- `/console/r/:runId` → run detail without requiring a project URL
- `/console/p/:projectId` → project runs
- `/console/p/:projectId/chat` → project operator chat
- `/console/p/:projectId/r/:runId` → project-scoped run detail

## Ownership

- Console API calls live in `skills/`.
- Reactive data lives in `store/cache.ts`.
- Generated API shapes come from `@/lib/api.generated`.
- Shared application code is limited to authentication, generated API types,
  node-reference parsing, IDE links, and global styling.
- The `builder/` subtree remains experimental and keeps its own pure model,
  validation, editor, and serialization layers.

## Chat behavior

The composer accepts up to five files of 10 MB each. A new conversation must be
created with a text-only first message because conversation creation uses JSON;
the UI asks the operator to attach files on the next turn.

On authenticated installations, the console requests the signed-in user's
project conversation and sends the active identity with each turn. Solo
installations operate without an identity.

## Persisted view preferences

| Key | Default | Purpose |
| --- | --- | --- |
| `archon.console.detailView` | `log` | Run-detail tab |
| `archon.console.showToolCalls` | `1` | Show tool calls in the stream |
| `archon.console.showSystem` | `0` | Show system events |
| `archon.console.runNodeFilter` | `all` | Filter the run stream by node |
| `archon.console.railWidth` | unset | Project rail width |
| `archon.console.lastWorkflow` | unset | Last selected workflow |
| `archon.console.builderProject` | unset | Builder project selection |

Local storage reads are guarded and fall back to these defaults.
