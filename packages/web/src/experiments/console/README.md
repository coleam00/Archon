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

| Key                              | Default | Purpose                                |
| -------------------------------- | ------- | -------------------------------------- |
| `archon.console.detailView`      | `log`   | Run-detail tab                         |
| `archon.console.showToolCalls`   | `1`     | Show tool calls in the stream          |
| `archon.console.showSystem`      | `0`     | Show system events                     |
| `archon.console.runNodeFilter`   | `all`   | Filter the run stream by node          |
| `archon.console.railWidth`       | unset   | Project rail width                     |
| `archon.console.lastWorkflow`    | unset   | Last selected workflow                 |
| `archon.console.builderProject`  | unset   | Builder project selection              |
| `archon.console.attentionAlerts` | `0`     | Alert when a run needs you or finishes |

Local storage reads are guarded and fall back to these defaults.

### Closed-console notifications

Settings → Alerts has a separate opt-in for Web Push. It requires an authenticated web identity, HTTPS or localhost, notification permission, and a browser with Push API support. Every opted-in browser receives run attention notices for this install. Notification clicks open `/runs/<id>`. On iOS, install the site as a home-screen web app first.

The first subscription quietly baselines existing pauses. Delivery is recorded per destination, after sending. A crash or a partial delivery failure can re-send to browsers that already received the notice; notifications use `tag: runId` so duplicates replace each other. Turning the toggle off deletes the subscription and unsubscribes the browser. The in-tab alert toggle stays independent.
