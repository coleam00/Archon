# Pi provider — known issues

## PI-LITELLM-RACE — extension provider registration/discovery races Pi's `reload()`

**Status:** worked around in Archon (deterministic fallback); **the root cause should be
fixed upstream** (in `pi-provider-litellm` and/or `@earendil-works/pi-coding-agent`).

### Symptom

Intermittent `Pi model not found: provider='litellm' model='<id>'` for a model that
demonstrably exists (the LiteLLM proxy serves it, and it is present in
`~/.pi/agent/models-store.json`). Failure rate was ~30–100% per fresh process; on the
long-running server it presents as _sticky_ per-cwd (the first message for a cwd wins or
loses the race, then the reloaded-loader cache pins that outcome until restart).

### Root cause

Extension providers are registered via an extension **factory** that Pi runs during
`DefaultResourceLoader.reload()`. The community `pi-provider-litellm` extension:

1. Registers its provider **inside an `async` factory** — the `pi.registerProvider()`
   call can land on the shared runtime's `pendingProviderRegistrations` queue _just
   after_ `reload()` resolves. Archon snapshots that queue immediately after `reload()`
   (`resource-loader.ts`, issue #2064), so the snapshot can **miss** the litellm
   provider entirely.
2. Discovers its **models asynchronously** (a network call to the proxy, enriched from
   `models.dev`) which the SDK does **not** await. So even when the provider _is_
   registered, `find()` can run before its models land.

No Archon-side `refresh()`/retry reliably closes this — you cannot discover models for a
provider that was never registered, and blocking on the snapshot penalizes every
extension-less first call (it also broke the #1877 loader-reuse tests with multi-second
polls).

### Current workaround (in this repo)

`provider.ts` LOOKUP-2 (`readExtensionModelFromStore` + `registerProvider`): when the
normal extension path misses, Archon reads the model directly from Pi's own on-disk
model-store cache (`models-store.json`, which a prior successful discovery reliably
populates and which the standalone `pi` CLI keeps warm) and registers the provider from
that entry — `baseUrl` + `api` + `apiKey` (resolved from `auth.json`) + the static model.
Resolution then no longer depends on the extension's async timing. This is **generic**
(keys on `parsed.provider`, so it also covers kiro and other extension providers), and
emits `pi.model_resolved_from_store_cache` when it fires. Measured 10/10 after the change.

Limitation: the fallback can only resolve models a **prior** discovery cached. A brand-new
model never yet discovered (by Archon or standalone `pi`) still needs the extension path.

### What "addressing it properly" looks like

- Upstream: have `reload()` **await** extension factories' provider registration (so the
  snapshot can't miss it), and/or have `pi-provider-litellm` register its provider
  synchronously and expose an awaitable "models ready" signal.
- Or: a first-class Pi SDK API to await "all extension providers registered + models
  discovered" before the first resolve, which Archon could call instead of the cache
  fallback.
- Track/report against `github.com/balcsida/pi-provider-litellm` and
  `github.com/earendil-works/pi`.
