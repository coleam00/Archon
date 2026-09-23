# `@archon/forge`

This optional leaf package owns Archon's forge-qualified identities and normalized inbound event contract. Forge adapters authenticate vendor deliveries, validate their payloads, and translate supported events into these schemas. Generic workflow admission does not import this package.

The maintained GitHub plugin owns the first source implementation, `normalizeGitHubWebhook`, its raw payload schemas, and its capability fixtures. Its inbound module entrypoint lives under `packages/adapters/src/forge/github/source-plugin.ts`; it exports its source capabilities and returns resolved receipts to the generic host and imports no core database or server implementation. It performs no network lookup. `@archon/forge/conformance` accepts source-owned fixtures and normalization callbacks to verify their normalized contract.

Authored selectors match exact event actions, repository and subject identity, plus the small variant-specific predicate set in `forgeEventSelectorSchema`. Input mappings accept direct fields or literals. The trigger host creates the literal binding schema with its existing workflow `jsonValueSchema`:

```ts
const bindingSchema = createForgeBindingSchema(jsonValueSchema);
```

A missing direct field rejects that binding. Source actors record forge provenance only; the trigger host separately resolves and authorizes the binding's Archon run-as identity.

## Outbound operations

`@archon/forge/operations` owns read-operation requests, results, metadata and audit payloads. `@archon/forge/dispatch` executes optional plugins; generic workflow execution imports neither. The independently executable GitHub plugin in `packages/adapters/src/forge/github/plugin.ts` implements `resolve` and `checks.state` through the same handshake as installed plugins.

See the [forge reference](../docs-web/src/content/docs/reference/forge.md) for the CLI, trusted configuration, UTF-8 process protocol, credentials and check semantics. Run `bun run test` and `bun run type-check` from this package to exercise contract, mapping and process conformance.
