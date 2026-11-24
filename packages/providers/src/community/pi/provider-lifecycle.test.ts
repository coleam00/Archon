import {
  capturedListener,
  mockPrompt,
  mockAbort,
  mockDispose,
  mockBindExtensions,
  mockCreateAgentSession,
  mockCheckAuth,
  mockResourceLoaderReload,
  mockLoaderRuntime,
  mockGetExtensions,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { describe, expect, test } from 'bun:test';
import type { ExtensionError } from '@earendil-works/pi-coding-agent';
import { PiProvider } from './provider';
import { claimPiExtensionProcessError } from './extension-error-broker';
describe('PiProvider lifecycle', () => {
  test('session.prompt rejection surfaces as a typed failure', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const promptError = new Error('pi backend exploded');
    mockPrompt.mockImplementationOnce(async () => {
      throw promptError;
    });

    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(failure).toEqual({ class: 'unknown', evidence: 'pi backend exploded' });
    // dispose still happens on error path
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test('abort signal mid-stream calls session.abort', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const controller = new AbortController();
    // Drive the listener with one chunk, then abort, then agent_end.
    mockPrompt.mockImplementationOnce(async () => {
      capturedListener?.({
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'partial',
          partial: { role: 'assistant' } as never,
        },
      });
      controller.abort();
      capturedListener?.(scriptedAgentEnd()[0]);
    });

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: controller.signal,
      })
    );
    expect(mockAbort).toHaveBeenCalled();
  });

  test('a detached extension timer failure becomes the node turn failure', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const extensionPath = '/extensions/fake-extension.ts';
    const loadedExtension = () =>
      ({
        extensions: [{ path: extensionPath, resolvedPath: extensionPath }],
        errors: [],
        runtime: mockLoaderRuntime,
      }) as unknown as ReturnType<typeof mockGetExtensions>;
    mockGetExtensions.mockImplementationOnce(loadedExtension);
    mockGetExtensions.mockImplementationOnce(loadedExtension);
    const timerError = new Error('extension timer failed');
    timerError.stack =
      `Error: extension timer failed\n    at callback (${extensionPath}:4:2)\n` +
      '    at timer (bun:1:1)';
    let claimed = false;
    mockPrompt.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          setTimeout(() => {
            claimed = claimPiExtensionProcessError(timerError);
          }, 0);
        })
    );

    const result = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(result.error).toBeUndefined();
    expect(claimed).toBe(true);
    expect(result.failure).toEqual({ class: 'unknown', evidence: timerError.stack });
    expect(result.chunks.at(-1)).toEqual({ type: 'settled' });
    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test('two extension-enabled turns run at the same time', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    const extensionPath = '/extensions/fake-extension.ts';
    mockGetExtensions.mockImplementation(
      () =>
        ({
          extensions: [{ path: extensionPath, resolvedPath: extensionPath }],
          errors: [],
          runtime: mockLoaderRuntime,
        }) as unknown as ReturnType<typeof mockGetExtensions>
    );
    let releaseFirst!: () => void;
    mockPrompt.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseFirst = resolve;
        })
    );
    try {
      const first = consume(
        new PiProvider().sendQuery('first', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );
      // The second turn must finish while the first is still mid-prompt.
      const second = await Promise.race([
        consume(
          new PiProvider().sendQuery('second', '/tmp', undefined, {
            model: 'google/gemini-2.5-pro',
          })
        ),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
      ]);
      releaseFirst();
      await first;

      expect(second).not.toBe('blocked');
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    } finally {
      mockGetExtensions.mockImplementation(() => ({
        extensions: [],
        errors: [],
        runtime: mockLoaderRuntime,
      }));
    }
  });

  test('a caller that aborted before the session starts never creates one', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const result = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: AbortSignal.abort(),
      })
    );

    expect(result.error?.message).toBe('Query aborted');
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  test('a caller that aborts during the credential check gets Query aborted, not an auth failure', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const controller = new AbortController();
    let entered: () => void = () => undefined;
    const checking = new Promise<void>(resolve => {
      entered = resolve;
    });
    mockCheckAuth.mockImplementationOnce(async (_providerId, options) => {
      entered();
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted.'));
        });
      });
    });
    resetScript(scriptedAgentEnd());

    const pending = consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: controller.signal,
      })
    );
    await checking;
    controller.abort();
    const result = await pending;

    expect(result.error?.message).toBe('Query aborted');
    expect(result.failure).toBeUndefined();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  test('Pi structured extension errors fail the turn with the supplied stack', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const extensionPath = '/extensions/fake-extension.ts';
    const loadedExtension = () =>
      ({
        extensions: [{ path: extensionPath, resolvedPath: extensionPath }],
        errors: [],
        runtime: mockLoaderRuntime,
      }) as unknown as ReturnType<typeof mockGetExtensions>;
    mockGetExtensions.mockImplementationOnce(loadedExtension);
    mockGetExtensions.mockImplementationOnce(loadedExtension);
    const extensionStack = `Error: extension handler failed\n    at handler (${extensionPath}:9:3)`;
    mockBindExtensions.mockImplementationOnce(async bindings => {
      const onError = (bindings as { onError?: (error: ExtensionError) => void }).onError;
      onError?.({
        extensionPath,
        event: 'session_start',
        error: 'extension handler failed',
        stack: extensionStack,
      });
    });

    const result = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(result.failure?.class).toBe('unknown');
    expect(result.failure?.evidence).toContain(extensionPath);
    expect(result.failure?.evidence).toContain(extensionStack);
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  // #3769: the retry needs a fresh session; the wedged one is disposed and the cached
  // extension loader reused.
  test('a retry after a watchdog abort on a wedged session gets a fresh session', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    mockPrompt.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const watchdog = new AbortController();
    const gen = new PiProvider().sendQuery('one', '/tmp', undefined, {
      model: 'google/gemini-2.5-pro',
      abortSignal: watchdog.signal,
    });
    expect((await gen.next()).value).toMatchObject({ type: 'session' });
    const abandoned = gen.next();
    abandoned.catch(() => undefined);
    while (mockPrompt.mock.calls.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    watchdog.abort();

    const retry = consume(
      new PiProvider().sendQuery('retry', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
    );
    const outcome = await Promise.race([
      retry,
      new Promise<'stuck'>(resolve => setTimeout(() => resolve('stuck'), 1000)),
    ]);

    expect(outcome).not.toBe('stuck');
    expect(outcome === 'stuck' ? undefined : outcome.error).toBeUndefined();
    expect(outcome === 'stuck' ? undefined : outcome.failure).toBeUndefined();
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(2);
    expect(mockDispose).toHaveBeenCalledTimes(2);
    expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
  });
});
