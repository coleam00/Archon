import {
  mockLogger,
  mockDispose,
  mockSetModel,
  createMockSessionResult,
  mockCreateAgentSession,
  createMockModel,
  mockModelRegistryFind,
  type MockModelRegistry,
  mockModelRegistryConstruct,
  mockResourceLoaderReload,
  mockLoaderRuntime,
  MockDefaultResourceLoader,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { describe, expect, mock, test } from 'bun:test';
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import { PiProvider } from './provider';
import { getOrCreateReloadedExtensionLoader } from './resource-loader';
describe('PiProvider extension loader', () => {
  //
  // Pi's reload() re-invokes every installed extension factory; the 2nd reload
  // in a process deadlocks on the first call's never-torn-down state. The fix
  // loads the extension-bearing loader ONCE per process per input set and
  // reuses it — so reload()/construct must run once across identical calls,
  // while each call still gets its own session.
  describe('extension loader reuse (issue #1877)', () => {
    test('reload() and loader construction run once across two sequential calls with identical inputs', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      await consume(
        new PiProvider().sendQuery('a', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );
      await consume(
        new PiProvider().sendQuery('b', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );

      // The bug was reload() (and the extension factory it drives) running per
      // call; after the fix the cached loader is built + reloaded exactly once.
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(1);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
      // Each call still gets its own session (correctness preserved).
      expect(mockCreateAgentSession).toHaveBeenCalledTimes(2);
      expect(mockDispose).toHaveBeenCalledTimes(2);
    });

    test('different cwd gets its own reloaded loader', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      await consume(
        new PiProvider().sendQuery('a', '/tmp/one', undefined, { model: 'google/gemini-2.5-pro' })
      );
      await consume(
        new PiProvider().sendQuery('b', '/tmp/two', undefined, { model: 'google/gemini-2.5-pro' })
      );

      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('a distinct per-node systemPrompt gets its own reloaded loader (no silent prompt reuse)', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      await consume(
        new PiProvider().sendQuery('a', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          systemPrompt: 'prompt A',
        })
      );
      await consume(
        new PiProvider().sendQuery('b', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          systemPrompt: 'prompt B',
        })
      );

      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('extensions disabled keeps a fresh loader per call and reloads native context', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      const opts = {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false },
      };
      await consume(new PiProvider().sendQuery('a', '/tmp', undefined, opts));
      await consume(new PiProvider().sendQuery('b', '/tmp', undefined, opts));

      // No caching on the extensions-off path: each loader can reload safely
      // because no extension factories run. Reload is what discovers Pi's
      // native AGENTS.md / CLAUDE.md context files.
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('distinct additionalSkillPaths get their own reloaded loader', async () => {
      const a = await getOrCreateReloadedExtensionLoader('/tmp', {
        additionalSkillPaths: ['/skills/x'],
      });
      const b = await getOrCreateReloadedExtensionLoader('/tmp', {
        additionalSkillPaths: ['/skills/y'],
      });
      expect(a).not.toBe(b);
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('concurrent callers (same key) share a single in-flight reload (the documented invariant)', async () => {
      // Gate reload() so both callers are in-flight before either resolves — the
      // exact race two parallel same-layer DAG nodes hit. Caching the resolved
      // value instead of the Promise would construct/reload twice and fail this.
      let releaseReload: (() => void) | undefined;
      mockResourceLoaderReload.mockImplementationOnce(
        () =>
          new Promise<undefined>(resolve => {
            releaseReload = (): void => resolve(undefined);
          })
      );

      const p1 = getOrCreateReloadedExtensionLoader('/tmp', {});
      const p2 = getOrCreateReloadedExtensionLoader('/tmp', {});
      // Both subscribed before reload resolves.
      releaseReload?.();
      const [l1, l2] = await Promise.all([p1, p2]);

      expect(l1).toBe(l2);
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(1);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });

    test('a failed reload is evicted so the next call retries cleanly', async () => {
      mockResourceLoaderReload.mockImplementationOnce(async () => {
        throw new Error('broken extension');
      });

      await expect(getOrCreateReloadedExtensionLoader('/tmp', {})).rejects.toThrow(
        /Pi extension load failed: broken extension/
      );

      // Entry was evicted on failure → the retry constructs + reloads again
      // (rather than returning the poisoned rejected promise forever).
      mockResourceLoaderReload.mockImplementationOnce(async () => undefined);
      const loader = await getOrCreateReloadedExtensionLoader('/tmp', {});
      expect(loader).toBeDefined();
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    // #3769: a watchdog abort ends the attempt waiting on a slow shared reload, and the
    // retry waits on that same reload instead of starting a second one.
    test('a retry after a watchdog abort during a slow reload reuses it once it settles', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());
      let settleReload: () => void = () => undefined;
      mockResourceLoaderReload.mockImplementationOnce(
        () =>
          new Promise<undefined>(resolve => {
            settleReload = () => resolve(undefined);
          })
      );

      const watchdog = new AbortController();
      const attempt = consume(
        new PiProvider().sendQuery('one', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          abortSignal: watchdog.signal,
        })
      );
      while (mockResourceLoaderReload.mock.calls.length < 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      watchdog.abort();
      expect((await attempt).error?.message).toBe('Query aborted');

      const retry = consume(
        new PiProvider().sendQuery('retry', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );
      // Let the retry reach the shared reload while it is still pending.
      await new Promise(resolve => setTimeout(resolve, 20));
      settleReload();
      const outcome = await retry;

      expect(outcome.error).toBeUndefined();
      expect(outcome.failure).toBeUndefined();
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });
  });

  //
  // Extension factories (e.g. pi-cursor's) run only during the single cached
  // reload() and queue their pi.registerProvider() calls on the loader's
  // shared runtime. The real SDK drains that queue into the FIRST session's
  // ModelRegistry and clears it — so before the fix, the 2nd+ sendQuery in a
  // process (DAG node 2) built a fresh registry that never saw extension
  // models and failed LOOKUP-2 with "Pi model not found".
  describe('extension provider registrations across sessions (issue #2064)', () => {
    /** Registration matching what pi-cursor queues at factory/load time. */
    const cursorRegistration = {
      name: 'cursor',
      config: {
        name: 'Cursor',
        baseUrl: 'http://localhost:33417/v1',
        apiKey: 'cursor-proxy',
        api: 'openai-completions',
        models: [],
      },
      extensionPath: '/mock/ext/pi-cursor',
    };

    /**
     * A per-call fake registry that resolves ONLY providers explicitly
     * registered into it — like the real one, whose static catalog does not
     * contain extension providers such as 'cursor'.
     */
    type ExtensionProviderConfig = Parameters<ModelRegistry['registerProvider']>[1];

    function fakeExtensionAwareRegistry(): MockModelRegistry & {
      registered: Map<string, ExtensionProviderConfig>;
    } {
      const registered = new Map<string, ExtensionProviderConfig>();
      return {
        registered,
        find: (provider: string, modelId: string) =>
          registered.has(provider) ? createMockModel(provider, modelId) : undefined,
        hasConfiguredAuth: mock(() => false),
        getApiKeyAndHeaders: mock(async () => ({ ok: true as const, apiKey: 'fake' })),
        registerProvider: ((name: string, config: ExtensionProviderConfig): void => {
          registered.set(name, config);
        }) as ModelRegistry['registerProvider'],
      };
    }

    /**
     * Simulate the real SDK's bindCore() drain for one createAgentSession
     * call: pi 0.84.0+ flushes the shared extension runtime's pending queue
     * into the SDK's INTERNAL registry, not ours — our provider re-applies
     * the snapshot separately (see `modelRegistry.registerProvider(name,
     * config)` in session-setup.ts). In this test the `bindCore` drain is a
     * no-op against our registry: the registrations land via the re-apply.
     * We just drain the queue so the second call's session sees an empty
     * queue (matching the SDK's behavior) — the source of truth is the
     * per-call registry re-apply.
     */
    function drainQueueOnceIntoSessionRegistry(): void {
      mockCreateAgentSession.mockImplementationOnce(
        async (_options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
          // The SDK drains the queue into ITS internal registry (built from
          // the same ModelRuntime); for our test we just need to clear the
          // shared queue so subsequent reloads don't replay it.
          mockLoaderRuntime.pendingProviderRegistrations = [];
          return createMockSessionResult();
        }
      );
    }

    test('extension-registered model resolves on the 2nd+ sendQuery (the issue #2064 scenario)', async () => {
      // The extension factory queued its registration during the single reload().
      mockLoaderRuntime.pendingProviderRegistrations = [cursorRegistration];

      const registries: ReturnType<typeof fakeExtensionAwareRegistry>[] = [];
      const nextRegistry = (): ReturnType<typeof fakeExtensionAwareRegistry> => {
        const registry = fakeExtensionAwareRegistry();
        registries.push(registry);
        return registry;
      };
      mockModelRegistryConstruct.mockImplementationOnce(() => nextRegistry());
      mockModelRegistryConstruct.mockImplementationOnce(() => nextRegistry());
      drainQueueOnceIntoSessionRegistry();
      drainQueueOnceIntoSessionRegistry();

      // Node 1: works with or without the fix (bindCore's drain registers cursor).
      resetScript(scriptedAgentEnd());
      const first = await consume(
        new PiProvider().sendQuery('a', '/tmp', undefined, { model: 'cursor/gpt-5.4-nano' })
      );
      expect(first.error).toBeUndefined();

      // Node 2: the queue is drained; only the loader-level snapshot re-apply
      // can register cursor into this call's fresh registry. Before the fix
      // this failed with "Pi model not found: provider='cursor'".
      resetScript(scriptedAgentEnd());
      const second = await consume(
        new PiProvider().sendQuery('b', '/tmp', undefined, { model: 'cursor/gpt-5.4-nano' })
      );
      expect(second.error).toBeUndefined();

      expect(registries).toHaveLength(2);
      expect(registries[1]?.registered.has('cursor')).toBe(true);
      // The extension model was resolved and set on both sessions.
      expect(mockSetModel).toHaveBeenCalledTimes(2);
      // Single-reload constraint (issue #1877) intact: no re-reload happened.
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });

    test('snapshot is captured before any session drains the shared queue and is served from cache', async () => {
      mockLoaderRuntime.pendingProviderRegistrations = [cursorRegistration];

      const entry = await getOrCreateReloadedExtensionLoader('/tmp', {});
      // Simulate the SDK's bindCore() drain (reassigns the runtime array).
      mockLoaderRuntime.pendingProviderRegistrations = [];

      expect(entry.providerRegistrations).toEqual([
        expect.objectContaining({ name: 'cursor', extensionPath: '/mock/ext/pi-cursor' }),
      ]);

      // Later nodes hit the cache and still see the captured registrations.
      const again = await getOrCreateReloadedExtensionLoader('/tmp', {});
      expect(again.providerRegistrations).toEqual(entry.providerRegistrations);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });

    test('missing extension model points at the extension rather than catalog refresh', async () => {
      mockLoaderRuntime.pendingProviderRegistrations = [cursorRegistration];
      mockModelRegistryFind.mockImplementationOnce(() => undefined);
      mockModelRegistryFind.mockImplementationOnce(() => undefined);
      resetScript(scriptedAgentEnd());

      const { failure } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'cursor/removed-model',
        })
      );

      expect(failure?.evidence).toContain('comes from an installed Pi extension');
      expect(failure?.evidence).toContain('Check the extension configuration and model name');
      expect(failure?.evidence).not.toContain('pi update --models');
    });

    test('a failing re-apply warns and does not fail nodes using other providers', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      mockLoaderRuntime.pendingProviderRegistrations = [
        { name: 'broken', config: { baseUrl: 'http://x' }, extensionPath: '/mock/ext/broken' },
      ];
      // Static-catalog model resolves via the default find(); registerProvider
      // rejects the broken extension config — mirroring a validation throw.
      mockModelRegistryConstruct.mockImplementationOnce(() => ({
        find: mockModelRegistryFind,
        registerProvider: (): void => {
          throw new Error('Provider broken: "apiKey" or "oauth" is required when defining models.');
        },
      }));

      resetScript(scriptedAgentEnd());
      const { error } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );

      expect(error).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          piExtensionProvider: 'broken',
          extensionPath: '/mock/ext/broken',
        }),
        'pi.extension_provider_reapply_failed'
      );
    });
  });
});
