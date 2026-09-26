import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import requiredCheckpointVerification from './laya-checkpoint-verification.json' with { type: 'json' };
import { createLayaTaskTypeHintResolver, formatLayaTaskTypeHint } from './laya-task-type-hint';

const trackTempRoot = trackTempRoots();

async function createBundleFixture(
  options: {
    checkpointVerification?: unknown;
    omitCheckpointVerification?: boolean;
  } = {}
): Promise<{
  modelDir: string;
  modelManifestSha256: string;
}> {
  const dir = trackTempRoot(await mkdtemp(path.join(os.tmpdir(), 'archon-laya-test-')));
  const contents: Record<string, string> = {
    'encoder.onnx': 'test encoder fixture',
    'head.onnx': 'test head fixture',
    'rl_agent_config.json': '{"max_len":16}',
    'tokenizer.json': '{"version":"1.0"}',
  };
  const files: Record<string, { sha256: string; sizeBytes: number }> = {};
  for (const [file, content] of Object.entries(contents)) {
    const bytes = Buffer.from(content);
    await writeFile(path.join(dir, file), bytes);
    files[file] = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    };
  }
  const checkpointVerification = options.omitCheckpointVerification
    ? undefined
    : Object.hasOwn(options, 'checkpointVerification')
      ? options.checkpointVerification
      : requiredCheckpointVerification;
  const manifest = JSON.stringify({
    schemaVersion: 1,
    runtimeCommit: '4066d5d5fbf08b66c6757ddeedbd797bd7655bc0',
    exporter: {
      repository: 'NandhaKishorM/laya',
      commit: '23a17522aa4942da6cce53a995a275760320b691',
    },
    checkpointVerification,
    model: {
      source: 'https://www.modelscope.cn/models/convaiinnovations/laya/typed-decisions',
      revision: '69f17eefb6910e69dbb031dcc3c8e3f556cff267',
      license: 'Apache-2.0',
      approvalStatus: 'approved',
      approvalReference: 'unit-test fixture only',
    },
    files,
  });
  await writeFile(path.join(dir, 'laya-bundle-manifest.json'), manifest);
  return {
    modelDir: dir,
    modelManifestSha256: createHash('sha256').update(manifest).digest('hex'),
  };
}

describe('createLayaTaskTypeHintResolver', () => {
  test('is disabled unless explicitly opted in', async () => {
    let loads = 0;
    const resolve = createLayaTaskTypeHintResolver({
      modelDir: '/does/not/exist',
      loadModel: async () => {
        loads += 1;
        throw new Error('must not load');
      },
    });

    expect(await resolve('Please explain this code')).toBeUndefined();
    expect(loads).toBe(0);
  });

  test('does not call Laya.load for a missing local bundle and disables after failure', async () => {
    let loads = 0;
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: path.join(os.tmpdir(), `missing-laya-${crypto.randomUUID()}`),
      modelManifestSha256: 'a'.repeat(64),
      loadModel: async () => {
        loads += 1;
        return {} as never;
      },
    });

    await expect(resolve('Implement this feature')).rejects.toThrow(
      'Local Laya advisory is unavailable'
    );
    expect(await resolve('Implement this feature')).toBeUndefined();
    expect(loads).toBe(0);
  });

  test('rejects an existing but incomplete bundle before loading', async () => {
    const modelDir = trackTempRoot(
      await mkdtemp(path.join(os.tmpdir(), 'archon-laya-incomplete-'))
    );
    let loads = 0;
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir,
      modelManifestSha256: 'a'.repeat(64),
      loadModel: async () => {
        loads += 1;
        return {} as never;
      },
    });

    await expect(resolve('Classify this request')).rejects.toThrow(
      'Local Laya advisory is unavailable'
    );
    expect(loads).toBe(0);
  });

  test('rejects manifests without the exact checkpoint verification marker before loading', async () => {
    const fixtures = await Promise.all([
      createBundleFixture({ omitCheckpointVerification: true }),
      createBundleFixture({
        checkpointVerification: {
          ...requiredCheckpointVerification,
          tensorCount: 205,
        },
      }),
    ]);

    for (const bundle of fixtures) {
      let loads = 0;
      const resolve = createLayaTaskTypeHintResolver({
        enabled: true,
        modelDir: bundle.modelDir,
        modelManifestSha256: bundle.modelManifestSha256,
        loadModel: async () => {
          loads += 1;
          return {} as never;
        },
      });

      await expect(resolve('Classify this request')).rejects.toThrow(
        'Local Laya advisory is unavailable'
      );
      expect(loads).toBe(0);
    }
  });

  test('loads only a complete explicit local bundle and reuses the model', async () => {
    const bundle = await createBundleFixture();
    let loads = 0;
    const seenMessages: string[] = [];
    const seenQuestions: unknown[] = [];
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: bundle.modelDir,
      modelManifestSha256: bundle.modelManifestSha256,
      loadModel: async resolvedDir => {
        loads += 1;
        expect(resolvedDir).not.toBe(path.resolve(bundle.modelDir));
        expect(path.basename(resolvedDir)).toMatch(/^archon-laya-/);
        expect(await Bun.file(path.join(resolvedDir, 'encoder.onnx')).text()).toBe(
          'test encoder fixture'
        );
        return {
          systemOne: async ({ message }: { message: string }, questions: unknown) => {
            seenMessages.push(message);
            seenQuestions.push(questions);
            return {
              answers: {
                task_type: {
                  type: 'choice',
                  choice: 'project_work',
                  probabilities: { project_work: 0.81 },
                },
              },
            };
          },
        } as never;
      },
    });

    expect(await resolve('  Implement this feature  ')).toEqual({
      taskType: 'project_work',
      probability: 0.81,
    });
    expect(await resolve('Review this change')).toEqual({
      taskType: 'project_work',
      probability: 0.81,
    });
    expect(loads).toBe(1);
    expect(seenMessages).toEqual(['Implement this feature', 'Review this change']);
    expect(seenQuestions[0]).toMatchObject({
      task_type: {
        instructions: expect.stringContaining(
          '“Run the tests in this project” is project_work; “resume that workflow run” is run_management.'
        ),
      },
    });
  });

  test('configures the default Laya loader for CPU inference and bounded threads', async () => {
    const bundle = await createBundleFixture();
    const load = mock(async (_modelDir: string, _options: { numThreads: number }) => ({
      systemOne: async () => ({
        answers: {
          task_type: { type: 'choice', choice: 'question', probabilities: { question: 0.9 } },
        },
      }),
    }));
    mock.module('./vendor/laya-ts/agent', () => ({ Agent: { load } }));
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: bundle.modelDir,
      modelManifestSha256: bundle.modelManifestSha256,
    });

    await expect(resolve('Explain this')).resolves.toEqual({
      taskType: 'question',
      probability: 0.9,
    });
    const [loadedDir, options] = load.mock.calls[0] ?? [];
    expect(loadedDir).not.toBe(path.resolve(bundle.modelDir));
    expect(options?.numThreads).toBeGreaterThan(0);
    expect(options?.numThreads).toBeLessThanOrEqual(2);
  });

  test('omits low-probability hints without disabling the local classifier', async () => {
    const bundle = await createBundleFixture();
    let inferences = 0;
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: bundle.modelDir,
      modelManifestSha256: bundle.modelManifestSha256,
      loadModel: async () =>
        ({
          systemOne: async () => {
            inferences += 1;
            const probability = inferences === 1 ? 0.74 : 0.9;
            return {
              answers: {
                task_type: {
                  type: 'choice',
                  choice: 'question',
                  probabilities: { question: probability },
                },
              },
            };
          },
        }) as never,
    });

    expect(await resolve('Could you explain this?')).toBeUndefined();
    expect(await resolve('Could you explain this?')).toEqual({
      taskType: 'question',
      probability: 0.9,
    });
    expect(inferences).toBe(2);
  });

  test('bounds input and skips concurrent local inference', async () => {
    const bundle = await createBundleFixture();
    let finishInference: ((value: unknown) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      signalStarted = resolve;
    });
    let seenLength = 0;
    let seenContext: unknown;
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: bundle.modelDir,
      modelManifestSha256: bundle.modelManifestSha256,
      loadModel: async () =>
        ({
          systemOne: async ({
            message,
            conversation_context,
          }: {
            message: string;
            conversation_context?: unknown;
          }) => {
            seenLength = message.length;
            seenContext = conversation_context;
            return new Promise(resolveResult => {
              finishInference = resolveResult;
              signalStarted?.();
            });
          },
        }) as never,
    });

    const first = resolve('a'.repeat(10_000), [
      { role: 'user', content: 'oldest' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'u'.repeat(200) },
      { role: 'assistant', content: 'a'.repeat(200) },
      { role: 'user', content: 'v'.repeat(200) },
      { role: 'assistant', content: 'b'.repeat(200) },
      { role: 'user', content: 'w'.repeat(200) },
      { role: 'assistant', content: 'c'.repeat(200) },
    ]);
    await started;
    expect(await resolve('second message')).toBeUndefined();
    expect(seenLength).toBeLessThanOrEqual(2_048);
    expect(seenContext).toHaveLength(6);
    expect(
      (seenContext as Array<{ content: string }>).reduce(
        (sum, turn) => sum + turn.content.length,
        0
      )
    ).toBe(1_024);
    expect(seenContext).not.toContainEqual(expect.objectContaining({ content: 'oldest' }));
    finishInference?.({
      answers: {
        task_type: { type: 'choice', choice: 'question', probabilities: { question: 0.9 } },
      },
    });
    await expect(first).resolves.toEqual({ taskType: 'question', probability: 0.9 });
  });

  test('returns at the deadline but holds the inference lock until late settlement', async () => {
    const bundle = await createBundleFixture();
    let rejectInference: ((error: unknown) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      signalStarted = resolve;
    });
    let inferenceCalls = 0;
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: bundle.modelDir,
      modelManifestSha256: bundle.modelManifestSha256,
      timeoutMs: 10,
      loadModel: async () =>
        ({
          systemOne: async () => {
            inferenceCalls += 1;
            return new Promise((_resolve, reject) => {
              rejectInference = reject;
              signalStarted?.();
            });
          },
        }) as never,
    });

    const first = resolve('Classify this request');
    await started;
    await expect(first).resolves.toBeUndefined();
    expect(await resolve('retry while native inference is active')).toBeUndefined();
    expect(inferenceCalls).toBe(1);

    rejectInference?.(new Error('late native failure'));
    await Bun.sleep(0);
    expect(await resolve('retry after native failure')).toBeUndefined();
    expect(inferenceCalls).toBe(1);
  });

  test('rejects unknown output and does not retry a broken classifier', async () => {
    const bundle = await createBundleFixture();
    let calls = 0;
    const resolve = createLayaTaskTypeHintResolver({
      enabled: true,
      modelDir: bundle.modelDir,
      modelManifestSha256: bundle.modelManifestSha256,
      loadModel: async () =>
        ({
          systemOne: async () => {
            calls += 1;
            return {
              answers: {
                task_type: {
                  type: 'choice',
                  choice: 'toString',
                  probabilities: { toString: 1 },
                },
              },
            };
          },
        }) as never,
    });

    await expect(resolve('hello')).rejects.toThrow('Local Laya advisory is unavailable');
    expect(await resolve('hello')).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe('formatLayaTaskTypeHint', () => {
  test('omits an absent hint', () => {
    expect(formatLayaTaskTypeHint()).toBe('');
  });

  test('marks a fixed task label as advisory and preserves routing controls', () => {
    const section = formatLayaTaskTypeHint({ taskType: 'project_work', probability: 0.81 });
    expect(section).toContain('**project_work**');
    expect(section).toContain('advisory only');
    expect(section).toContain('cannot select or dispatch a workflow');
    expect(section).toContain('or change credentials, validation, or approval requirements');
  });
});
