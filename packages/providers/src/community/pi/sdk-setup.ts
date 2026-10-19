/**
 * Prepares the Pi SDK to load and run inside a compiled Archon binary: the
 * `PI_PACKAGE_DIR` shim Pi's config.js needs before its first import, and the
 * once-per-process registration of the backends and OAuth flows Bun's `--compile`
 * cannot follow (see the lazy-load note in ./provider.ts).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

/**
 * Write a minimal package.json to a stable tmpdir and set `PI_PACKAGE_DIR`
 * so Pi's `config.js` short-circuits its `dirname(process.execPath)` walk
 * (which fails inside a compiled archon binary). Pi only reads three
 * optional fields from that package.json — `piConfig.name`, `piConfig.configDir`,
 * and `version` — so the stub is genuinely minimal. Idempotent: the file is
 * only written once per host (existsSync check), and the env var is set on
 * every call so multiple PiProvider instances stay consistent.
 *
 * Done on each sendQuery rather than at module load so (a) the file write
 * is paid only when Pi is actually used, and (b) the env var can't get
 * clobbered between registration and invocation.
 */
export function ensurePiPackageDirShim(): void {
  const shimDir = join(tmpdir(), 'archon-pi-shim');
  const shimPkgJson = join(shimDir, 'package.json');
  if (!existsSync(shimPkgJson)) {
    // `piConfig: {}` is explicit so Pi's defaults (`name: 'pi'`,
    // `configDir: '.pi'`) kick in — matches Pi's standalone behavior.
    try {
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(
        shimPkgJson,
        JSON.stringify({
          name: 'archon-pi-shim',
          version: '0.0.0',
          piConfig: {},
        })
      );
    } catch (error) {
      // Surface as a classified error so the executor's catch sees a known
      // shape instead of a raw EACCES/ENOSPC from node:fs.
      const err = error as NodeJS.ErrnoException;
      throw new Error(`Pi shim setup failed at ${shimDir}: ${err.message}`);
    }
  }
  process.env.PI_PACKAGE_DIR = shimDir;
}

// ─── Bedrock backend registration (compiled-binary parity) ───────────────────

/**
 * Registrar for Pi's Bedrock backend module. Split out from
 * `ensureBedrockProviderRegistered` so tests can inject a spy without touching
 * the real SDK (Bun's `mock.module` is process-global and irreversible).
 */
export type BedrockRegistrar = () => Promise<void>;

/**
 * The default registrar: dynamically import the Pi SDK's Bedrock override hook
 * and the statically-bundled Bedrock module, then wire them together.
 *
 * Both specifiers are STRING LITERALS on purpose — that is the entire point of
 * this fix. Pi lazy-loads every backend via `import()`, and for all backends
 * except Bedrock the specifier is a string literal that Bun's `--compile`
 * static analysis can follow and embed. Bedrock's loader instead routes through
 * a computed-specifier indirection (`importNodeOnlyApi('./bedrock-converse-stream.ts')`
 * in pi-ai's `bedrock-converse-stream.lazy.js`) that Bun cannot resolve, so
 * `bedrock-converse-stream.js` + `@aws-sdk/client-bedrock-runtime` never get
 * bundled and a compiled Archon binary fails with `Cannot find module … /$bunfs/…`
 * on any `amazon-bedrock/*` model (issue #2154).
 *
 * Pi fixed the identical bug in their own binary (earendil-works/pi#2349,
 * PR #2350): `setBedrockProviderModule()` is checked FIRST inside the loader,
 * and is fed the module via the static `@earendil-works/pi-ai/bedrock-provider`
 * subpath, which Bun DOES bundle. Archon compiles its own CLI and never runs
 * Pi's bun entrypoint (`bun/register-bedrock.js`), so we mirror that shim here.
 *
 * The two subpaths match Pi's own 0.80.6 `bun/register-bedrock.js` shim exactly:
 * `setBedrockProviderModule` from `@earendil-works/pi-ai/compat` (the SDK moved
 * it off the package root into the compat entrypoint) and `bedrockProviderModule`
 * from `@earendil-works/pi-ai/bedrock-provider`. Both are safe to import inside a
 * compiled binary — Pi loads them in its own working binary — unlike
 * `@earendil-works/pi-coding-agent/config.js`, which reads a package.json next to
 * `process.execPath` (see the header note and `ensurePiPackageDirShim`).
 */
async function defaultBedrockRegistrar(): Promise<void> {
  const [compatModule, bedrockModule] = await Promise.all([
    import('@earendil-works/pi-ai/compat'),
    import('@earendil-works/pi-ai/bedrock-provider'),
  ]);
  compatModule.setBedrockProviderModule(bedrockModule.bedrockProviderModule);
}

let bedrockRegistrationPromise: Promise<void> | undefined;

/**
 * Register Pi's Bedrock backend override once per process. Idempotent: the
 * registrar runs on the first call and every later call reuses the cached
 * promise. Called from `sendQuery()` (not at module load), so it never
 * eagerly pulls the Pi SDK into module scope — preserving the lazy-load
 * invariant guarded by `provider-lazy-load.test.ts`.
 *
 * Registration failure is swallowed with a WARN rather than thrown: the hook
 * only matters for `amazon-bedrock/*` models, so a failure must not break
 * `anthropic/*`, `cursor/*`, or any other Pi backend. If a Bedrock node then
 * runs, Pi's own `importNodeOnlyApi` fallback still surfaces the original
 * `Cannot find module` error — i.e. degradation is strictly no worse than the
 * pre-fix behavior, and the WARN keeps it searchable.
 */
export function ensureBedrockProviderRegistered(
  registrar: BedrockRegistrar = defaultBedrockRegistrar
): Promise<void> {
  bedrockRegistrationPromise ??= registrar()
    .then(() => {
      getLog().debug('pi.bedrock_provider_register_completed');
    })
    .catch((err: unknown) => {
      getLog().warn({ err }, 'pi.bedrock_provider_register_failed');
    });
  return bedrockRegistrationPromise;
}

/** Test-only: reset the once-per-process registration cache. */
export function resetBedrockRegistrationForTest(): void {
  bedrockRegistrationPromise = undefined;
}

// ─── OAuth flow registration (compiled-binary parity) ────────────────────────

/**
 * Registrar for Pi's subscription OAuth flow modules. Split out from
 * `ensurePiOAuthFlowsRegistered` for the same test-injection reason as
 * `BedrockRegistrar`.
 */
export type OAuthFlowRegistrar = () => Promise<void>;

/**
 * The default registrar: dynamically import pi-ai's `bun-oauth` entrypoint and
 * register the flow modules it imports statically.
 *
 * Same bug class as Bedrock (#2154). pi-ai's credential resolver loads each
 * subscription OAuth flow (openai-codex, anthropic, github-copilot, …) through
 * `importOAuthModule(specifier)` in `dist/auth/oauth/load.js`, a
 * computed-specifier `import()` that Bun's `--compile` cannot follow. The flow
 * modules are never embedded, so every Pi node on a `type: "oauth"`
 * `auth.json` credential fails in a compiled binary with
 * `OAuth auth derivation failed for <provider>: Cannot find module './<flow>.js'`.
 *
 * Each loader checks `registerBundledOAuthFlowLoaders()` first. pi-ai's public
 * `@earendil-works/pi-ai/bun-oauth` subpath statically imports every flow and
 * calls it via `registerBunOAuthFlows()`; Pi's own binary does exactly that.
 * The string-literal specifier here is what lets Bun follow and embed those
 * static imports. Registering in source mode is harmless: the same modules
 * resolve normally, they are just loaded through the registered table.
 */
async function defaultOAuthFlowRegistrar(): Promise<void> {
  const { registerBunOAuthFlows } = await import('@earendil-works/pi-ai/bun-oauth');
  registerBunOAuthFlows();
}

let oauthFlowRegistrationPromise: Promise<void> | undefined;

/**
 * Register Pi's subscription OAuth flow loaders once per process, with the same
 * caching, lazy-load, and failure contract as `ensureBedrockProviderRegistered`.
 * A failure only affects OAuth-credentialed backends, so it is swallowed with a
 * WARN: API-key and `models.json` backends keep working, and an OAuth node then
 * surfaces pi-ai's original `Cannot find module` error.
 *
 * Both this and the Bedrock override register into pi-ai module state, so they
 * only take effect while Pi resolves the same pi-ai instance this package
 * imports. `pi-sdk-instance.test.ts` guards that.
 */
export function ensurePiOAuthFlowsRegistered(
  registrar: OAuthFlowRegistrar = defaultOAuthFlowRegistrar
): Promise<void> {
  oauthFlowRegistrationPromise ??= registrar()
    .then(() => {
      getLog().debug('pi.oauth_flows_register_completed');
    })
    .catch((err: unknown) => {
      getLog().warn({ err }, 'pi.oauth_flows_register_failed');
    });
  return oauthFlowRegistrationPromise;
}

/** Test-only: reset the once-per-process registration cache. */
export function resetOAuthFlowRegistrationForTest(): void {
  oauthFlowRegistrationPromise = undefined;
}
