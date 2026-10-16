# Community Forge Adapters

This directory holds the bundled Gitea and GitLab adapters for existing installs.
They receive focused compatibility, correctness and security fixes; new forges ship
as plugins in contributor-owned repositories
([`direction.md §community-plugins`](../../../../../.archon/direction.md#community-plugins)).

## Adding a forge

A new forge attaches through the `@archon/forge` contract without a new bundled
adapter or a platform-specific registration in the server:

- [`@archon/forge`](../../../../forge/src/index.ts) owns normalized forge operations.
- [Publish a plugin: tags and executable release assets](../../../../docs-web/src/content/docs/guides/publishing-plugins.md#tags-and-executable-release-assets)
  covers the forge manifest, release assets and installation.

## Maintaining bundled adapters

Existing bundled adapters implement `IPlatformAdapter` from `@archon/core` and
receive webhooks through the server's
[`webhook routes`](../../../../server/src/routes/webhooks.ts).
The [GitHub adapter](../../forge/github/adapter.ts) is the maintained bundled reference.

Runtime behavior is independent of the platform identifier. `messagePersistence: 'adapter'`
means the adapter persists direct-chat messages; `defaultWorkflowDispatch: 'background'`
backgrounds all fresh runs, including workflows that can pause. Pauses wait in the
attention queue until answered. Optional `sendStructuredEvent` delivers rich events;
`prepareBackgroundConversation` prepares worker integration and returns an awaited finalizer.
Hosts own platform policies in
[`platform-policies.ts`](../../platform-policies.ts).

## Testing

### Mock isolation (required)

Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it. Your test file **must** run in its own `bun test` invocation to avoid polluting other tests.

When adding a test for a bundled adapter that mocks modules, put it in its own
`testGroups` entry in [`packages/adapters/package.json`](../../../package.json).
The package test runner starts each group in a separate process. Do not combine tests
that mock the same modules differently (such as `@archon/paths` or `@archon/git`).

### Lazy logger pattern

Always use a module-level `cachedLog` + `getLog()` getter so test mocks can intercept `createLogger` before the logger is instantiated:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.my-forge');
  return cachedLog;
}
```

### Log event naming

Follow the `{domain}.{action}_{state}` convention. Standard states: `_started`, `_completed`, `_failed`. Always pair `_started` with `_completed` or `_failed`.

```typescript
// ✅ CORRECT
getLog().info({ conversationId }, 'adapter.comment_post_completed');
getLog().error({ err, conversationId }, 'adapter.comment_post_failed');

// ❌ WRONG
getLog().info({ conversationId }, 'comment_posted');
getLog().error({ err }, 'error_posting');
```

## Reference

See the GitHub adapter (`packages/adapters/src/forge/github/`) for a complete working example.
