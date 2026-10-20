/**
 * Real-SDK acceptance test for the dynamic model catalog (#2682).
 *
 * pi-coding-agent 0.84's `ModelRuntime.create()` builds its model collection
 * store-aware: models the user's Pi TUI learned dynamically land in
 * `~/.pi/agent/models-store.json` and resolve in Archon without any Archon
 * configuration — model availability derives from the user's Pi, not from a
 * frozen snapshot baked into whichever SDK version Archon pins.
 *
 * The acceptance criterion (maintainer direction on #2682): a model present
 * in the user's `models-store.json` and absent from the baked catalog
 * resolves through the exact construction a Pi turn performs (`turn.ts`) —
 * `new ModelRegistry(await ModelRuntime.create(...))` followed by
 * `registry.find(provider, modelId)`.
 *
 * Mock isolation: `provider-test-fixture.ts` mocks the Pi SDK at module
 * scope for the provider unit tests, and Bun's
 * `mock.module()` is process-global, irreversible, and matches subpath
 * imports of the mocked package too. This file therefore loads the SDK by
 * filesystem deep path and probes the result; when the mock is in effect
 * (multiple files bundled into one `bun test` process) the test self-skips
 * with a pointer at the right invocation. The package.json test script runs
 * this file in its own process, so it always exercises the real SDK in CI —
 * same pattern as request-auth.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

interface RealPiSdk {
  ModelRuntime: {
    create(options?: {
      authPath?: string;
      refreshOnCreate?: boolean;
    }): Promise<{ getModel?: unknown }>;
  };
  ModelRegistry: new (
    runtime: object
  ) => {
    find(provider: string, modelId: string): { provider: string; id: string } | undefined;
  };
}

async function loadRealSdk(): Promise<RealPiSdk> {
  const sdkIndexPath = fileURLToPath(await import.meta.resolve('@earendil-works/pi-coding-agent'));
  const load = async <T>(file: string): Promise<T> =>
    (await import(pathToFileURL(join(dirname(sdkIndexPath), 'core', file)).href)) as T;
  const { ModelRuntime } = await load<Pick<RealPiSdk, 'ModelRuntime'>>('model-runtime.js');
  const { ModelRegistry } = await load<Pick<RealPiSdk, 'ModelRegistry'>>('model-registry.js');
  return { ModelRuntime, ModelRegistry };
}

/** True iff the deep-path load yields the real SDK (vs provider-test-fixture.ts's mock). */
async function probeRealSdkAvailable(): Promise<boolean> {
  // Isolate the probe from the host's real ~/.pi/agent: module load runs
  // before beforeEach, so without this the create() below would read the
  // developer's actual Pi config. refreshOnCreate: false matches the test
  // body's own create call.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = '/nonexistent-for-archon-store-probe';
  try {
    const { ModelRuntime, ModelRegistry } = await loadRealSdk();
    if (typeof ModelRuntime.create !== 'function' || typeof ModelRegistry !== 'function') {
      return false;
    }
    // The shared mock factory satisfies both typeof checks above (it ships `ModelRuntime.create` as a mock fn and `ModelRegistry` as a mock
    // constructor), and its registry `find` fabricates a model for whatever
    // ref is asked — the test would pass vacuously against it. Only a real
    // ModelRuntime instance carries getModel (the mock stubs only
    // setRuntimeApiKey/getAuth/hasConfiguredAuth), so probe the constructed
    // instance — same discriminator as request-auth.integration.test.ts.
    const inst = await ModelRuntime.create({ refreshOnCreate: false });
    return typeof inst.getModel === 'function';
  } catch {
    return false;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

const realSdkAvailable = await probeRealSdkAvailable();
if (!realSdkAvailable) {
  console.warn(
    '\n⚠️  model-store.integration.test.ts: skipping — the real pi-coding-agent SDK\n' +
      '   is not loadable in this bun process (mock.module contamination). Run:\n' +
      '     bun test src/community/pi/model-store.integration.test.ts\n'
  );
}

/** A model ref that exists ONLY in the scratch models-store.json below. */
const STORE_ONLY_MODEL = { provider: 'openrouter', id: 'archon-test/store-only-model' };

describe('dynamic model catalog (models-store.json)', () => {
  let scratchDir: string | undefined;
  let originalAgentDir: string | undefined;
  let originalOffline: string | undefined;

  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalOffline = process.env.PI_OFFLINE;
    scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-model-store-'));
    process.env.PI_CODING_AGENT_DIR = scratchDir;
    // Belt and braces: create() defaults to no network refresh, and
    // PI_OFFLINE gates any runtime network path the SDK might add.
    process.env.PI_OFFLINE = '1';
  });

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
  });

  test.skipIf(!realSdkAvailable)(
    'a model present only in models-store.json resolves via ModelRegistry.find',
    async () => {
      // The store shape the Pi TUI writes: per-provider model lists learned
      // from the provider's live catalog.
      writeFileSync(
        join(scratchDir as string, 'models-store.json'),
        JSON.stringify({
          openrouter: {
            models: [
              {
                id: STORE_ONLY_MODEL.id,
                name: 'Archon store-only test model',
                api: 'openai-completions',
                baseUrl: 'https://openrouter.ai/api/v1',
                provider: STORE_ONLY_MODEL.provider,
                reasoning: false,
                input: ['text'],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131072,
                maxTokens: 32768,
              },
            ],
            checkedAt: Date.now(),
            lastModified: Date.now(),
          },
        })
      );

      const { ModelRuntime, ModelRegistry } = await loadRealSdk();
      // Same construction as a Pi turn (authPath undefined here —
      // auth is irrelevant to catalog resolution).
      const runtime = await ModelRuntime.create({});
      const registry = new ModelRegistry(runtime);

      const model = registry.find(STORE_ONLY_MODEL.provider, STORE_ONLY_MODEL.id);
      expect(model).toBeDefined();
      expect(model?.provider).toBe(STORE_ONLY_MODEL.provider);
      expect(model?.id).toBe(STORE_ONLY_MODEL.id);
    }
  );
});
