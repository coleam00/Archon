import {
  mockFindConversationByPlatformId,
  mockHandleMessage,
  mockAddMessage,
  mockGenerateAndSetTitle,
  mockArchonHome,
  setMockArchonHome,
  NOW,
  MOCK_CONV,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { removeTempTree } from '@archon/paths/test-utils';
import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { workflowRunConfigKeys } from '@archon/core/config';
import {
  workflowRunLaunchConfigSchema,
  workflowRunLaunchJsonSchema,
  workflowRunLaunchMultipartSchema,
} from './schemas/workflow-run-launch.schemas';

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/:name/run
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:name/run', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
    mockGenerateAndSetTitle.mockReset();
  });

  test.each(['text', 'mixed', 'too many', 'too large'] as const)(
    'refuses %s multipart files without writing uploads or dispatching',
    async kind => {
      const originalHome = mockArchonHome;
      const home = await mkdtemp(join(tmpdir(), 'archon-invalid-launch-files-'));
      setMockArchonHome(home);
      const write = spyOn(fsPromises, 'writeFile');
      mockFindConversationByPlatformId.mockResolvedValue(null);
      try {
        const form = new FormData();
        form.set('conversationId', 'web-test-abc');
        form.set('message', 'Deploy');
        if (kind === 'text' || kind === 'mixed') form.append('files', 'request.txt');
        if (kind === 'mixed' || kind === 'too many') {
          const count = kind === 'too many' ? 6 : 1;
          for (let index = 0; index < count; index++) {
            form.append(
              'files',
              new File(['details'], `request-${index}.txt`, { type: 'text/plain' })
            );
          }
        }
        if (kind === 'too large') {
          form.append(
            'files',
            new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' })
          );
        }
        const { app } = makeApp();
        const response = await app.request('/api/workflows/deploy/run', {
          method: 'POST',
          body: form,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error:
            kind === 'too many'
              ? 'Maximum 5 files per message'
              : kind === 'too large'
                ? 'File "large.txt" exceeds the 10 MB size limit'
                : 'files must contain only file parts',
        });
        expect(mockHandleMessage).not.toHaveBeenCalled();
        expect(mockAddMessage).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(await fsPromises.readdir(home)).toEqual([]);
      } finally {
        write.mockRestore();
        setMockArchonHome(originalHome);
        await removeTempTree(home);
      }
    }
  );

  test('publishes both launch bodies with transport-specific fields', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/openapi.json');
    expect(response.status).toBe(200);
    const doc = (await response.json()) as ReturnType<typeof app.getOpenAPIDocument>;
    type Schema = NonNullable<NonNullable<typeof doc.components>['schemas']>[string];
    function resolve(schema: Schema | undefined): Exclude<Schema, { $ref: string }> {
      if (!schema) throw new Error('Missing schema');
      if ('$ref' in schema)
        return resolve(doc.components?.schemas?.[schema.$ref.split('/').at(-1) ?? '']);
      return schema;
    }
    const body = doc.paths['/api/workflows/{name}/run']?.post?.requestBody;
    expect(body).toBeDefined();
    if (!body || '$ref' in body) throw new Error('Missing launch request body');
    expect(body.required).toBe(true);
    expect(Object.keys(body.content)).toEqual(['application/json', 'multipart/form-data']);
    const json = resolve(body.content['application/json']?.schema);
    const form = resolve(body.content['multipart/form-data']?.schema);
    for (const schema of [json, form]) {
      expect(schema.required).toEqual(['conversationId', 'message']);
      expect(resolve(schema.properties?.message).minLength).toBe(1);
    }
    expect(resolve(json.properties?.conversationId).pattern).toBeUndefined();
    expect(resolve(form.properties?.conversationId).pattern).toBe('^[\\w-]+$');
    for (const field of ['inputs', 'tiers', 'aliases', 'config']) {
      expect(resolve(json.properties?.[field]).type).toBe('object');
      expect(resolve(form.properties?.[field]).type).toBe('string');
      expect(resolve(form.properties?.[field]).description).toContain('JSON');
    }
    expect(resolve(json.properties?.inputs).additionalProperties).toEqual({ type: 'string' });
    expect(Object.keys(resolve(json.properties?.tiers).properties ?? {})).toEqual([
      'small',
      'medium',
      'large',
    ]);
    const config = resolve(json.properties?.config);
    expect(config.additionalProperties).toBe(false);
    expect(Object.keys(config.properties ?? {}).sort()).toEqual([...workflowRunConfigKeys].sort());
    for (const field of ['layer', 'source', 'docsPath', 'envVars'])
      expect(config.properties).not.toHaveProperty(field);
    expect(resolve(resolve(config.properties?.docs).properties?.path).type).toBe('string');
    expect(resolve(config.properties?.env).additionalProperties).toEqual({ type: 'string' });
    expect(config.not).toEqual({ required: ['assistant', 'defaultAssistant'] });
    expect(json.not).toEqual({ required: ['adopt_run_id', 'supersedes_run_id'] });
    for (const field of ['adopt_run_id', 'supersedes_run_id']) {
      expect(resolve(json.properties?.[field]).minLength).toBe(1);
      expect(form.properties).not.toHaveProperty(field);
    }
    const files = resolve(form.properties?.files);
    expect(files.type).toBe('array');
    expect(files.maxItems).toBe(5);
    expect(resolve(files.items)).toMatchObject({ type: 'string', format: 'binary' });
    expect(files.description).toContain('10485760 bytes');
  });

  test('dispatches workflow run to orchestrator and returns accepted', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy to staging',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy to staging' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe('started');
  });

  // The message is data: it must reach the run byte for byte, and no word in it may
  // set `--force` (#4159).
  test.each([
    'Explain what git push --force does',
    'Fix the "login bug"\n\nsteps:\n  1. a',
    "'tis the season",
  ])('hands the orchestrator the message verbatim: %j', async message => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message }),
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      message,
      expect.objectContaining({
        workflowName: 'test-suite',
        isolationHints: { workflowType: 'thread', workflowId: 'web-test-abc' },
      })
    );
  });

  test('accepts a percent-encoded namespaced name and forwards the decoded name', async () => {
    // Regression guard: percent-encoded '/' must be decoded and validate, not raw-route to 400.
    const { isValidWorkflowName, isValidCommandName } = await import(
      '@archon/workflows/command-validation'
    );
    const segmentOk = (seg: string) =>
      !!seg && !seg.startsWith('.') && !seg.includes('\\') && !seg.includes('..');
    // Real namespaced logic: `triage/review` is valid (one subfolder deep).
    (isValidWorkflowName as ReturnType<typeof mock>).mockImplementationOnce((name: string) => {
      if (!name) return false;
      const segments = name.split('/');
      if (segments.length > 2) return false;
      return segments.every(segmentOk);
    });
    // Strict command logic that rejects `/`, so this test goes red if the run
    // route validates with isValidCommandName instead of isValidWorkflowName.
    (isValidCommandName as ReturnType<typeof mock>).mockImplementationOnce(
      (name: string) => segmentOk(name) && !name.includes('/')
    );

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Run triage',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/triage%2Freview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Run triage' }),
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      'Run triage',
      expect.objectContaining({ workflowName: 'triage/review' })
    );
  });

  test('persists user message to DB when conversation found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      MOCK_CONV.id,
      'user',
      'Deploy',
      undefined,
      undefined
    );
  });

  test.each([
    ['message', 'message'],
    ['message', 'workflow'],
    ['workflow', 'message'],
    ['workflow', 'workflow'],
  ])(
    'cleanup of %s preserves a concurrent %s upload before its first write',
    async (firstIngress, secondIngress) => {
      const originalHome = mockArchonHome;
      const home = await mkdtemp(join(tmpdir(), 'archon-prewrite-uploads-'));
      setMockArchonHome(home);
      const uploadDir = join(home, 'artifacts', 'uploads', 'web-test-abc');
      const lockManager = new ConversationLockManager();
      const releaseFirst = Promise.withResolvers<void>();
      const secondBeforeWrite = Promise.withResolvers<void>();
      const allowWrite = Promise.withResolvers<void>();
      const waitForIdle = async () => {
        const deadline = Date.now() + 5000;
        while (lockManager.getStats().active > 0 && Date.now() < deadline) {
          await new Promise(resolve => setImmediate(resolve));
        }
        expect(lockManager.getStats().active).toBe(0);
      };
      const originalWriteFile = fsPromises.writeFile;
      let calls = 0;
      const write = spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
        if (dirname(String(args[0])) === uploadDir && ++calls === 2) {
          secondBeforeWrite.resolve();
          await allowWrite.promise;
        }
        return originalWriteFile(...args);
      });
      mockFindConversationByPlatformId.mockResolvedValue(MOCK_CONV);
      mockHandleMessage.mockImplementation(async (_adapter, _id, message) => {
        if (message === 'first') await releaseFirst.promise;
      });
      try {
        const { app } = makeApp(lockManager);
        const send = (ingress: string, message: string) => {
          const form = new FormData();
          form.set('conversationId', 'web-test-abc');
          form.set('message', message);
          form.set('files', new File([message], 'request.txt', { type: 'text/plain' }));
          return app.request(
            ingress === 'message'
              ? '/api/conversations/web-test-abc/message'
              : '/api/workflows/deploy/run',
            { method: 'POST', body: form }
          );
        };
        expect((await send(firstIngress, 'first')).status).toBe(200);
        const second = send(secondIngress, 'second');
        await secondBeforeWrite.promise;
        releaseFirst.resolve();
        await waitForIdle();
        allowWrite.resolve();
        const response = await second;
        expect(response.status).toBe(200);
      } finally {
        releaseFirst.resolve();
        allowWrite.resolve();
        await waitForIdle();
        write.mockRestore();
        setMockArchonHome(originalHome);
        await removeTempTree(home);
      }
    }
  );

  test('message dispatch receives every multipart attachment with its contents', async () => {
    const originalHome = mockArchonHome;
    const home = await mkdtemp(join(tmpdir(), 'archon-message-files-'));
    setMockArchonHome(home);
    const received: { name: string; content: string }[] = [];
    mockFindConversationByPlatformId.mockResolvedValue(null);
    mockHandleMessage.mockImplementationOnce(async (_adapter, _id, _message, context) => {
      for (const file of context.attachedFiles ?? []) {
        received.push({ name: file.name, content: await fsPromises.readFile(file.path, 'utf8') });
      }
    });
    try {
      const form = new FormData();
      form.set('message', 'Read both attachments');
      form.append('files', new File(['first contents'], 'first.txt', { type: 'text/plain' }));
      form.append('files', new File(['second contents'], 'second.txt', { type: 'text/plain' }));
      const { app } = makeApp();
      const response = await app.request('/api/conversations/web-test-abc/message', {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true, status: 'started' });
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
      expect(received).toEqual([
        { name: 'first.txt', content: 'first contents' },
        { name: 'second.txt', content: 'second contents' },
      ]);
      expect(await fsPromises.readdir(join(home, 'artifacts', 'uploads', 'web-test-abc'))).toEqual(
        []
      );
    } finally {
      setMockArchonHome(originalHome);
      await removeTempTree(home);
    }
  });

  test('refuses launch when the chat request cannot be persisted', async () => {
    mockFindConversationByPlatformId.mockResolvedValueOnce(MOCK_CONV);
    mockAddMessage.mockRejectedValueOnce(new Error('history database unavailable'));
    const { app, mockWebAdapter } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to save workflow request to history' });
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    expect(mockWebAdapter.setConversationDbId).not.toHaveBeenCalled();
  });

  test.each(['message', 'workflow'])(
    '%s rolls back only this request uploads when history persistence fails',
    async ingress => {
      const originalHome = mockArchonHome;
      const home = await mkdtemp(join(tmpdir(), 'archon-history-failure-'));
      setMockArchonHome(home);
      try {
        const uploadDir = join(home, 'artifacts', 'uploads', 'web-test-abc');
        await mkdir(uploadDir, { recursive: true });
        await writeFile(join(uploadDir, 'existing.txt'), 'another request');
        mockFindConversationByPlatformId.mockResolvedValueOnce(MOCK_CONV);
        mockAddMessage.mockRejectedValueOnce(new Error('history database unavailable'));
        const form = new FormData();
        form.set('conversationId', 'web-test-abc');
        form.set('message', 'Deploy with attachment');
        form.set('files', new File(['details'], 'request.txt', { type: 'text/plain' }));
        const { app } = makeApp();
        const response = await app.request(
          ingress === 'message'
            ? '/api/conversations/web-test-abc/message'
            : '/api/workflows/deploy/run',
          {
            method: 'POST',
            body: form,
          }
        );
        expect(response.status).toBe(500);
        expect(mockAddMessage).toHaveBeenCalledWith(
          MOCK_CONV.id,
          'user',
          'Deploy with attachment',
          { files: [{ name: 'request.txt', mimeType: 'text/plain', size: 7 }] },
          undefined
        );
        expect(mockHandleMessage).not.toHaveBeenCalled();
        expect(await fsPromises.readdir(uploadDir)).toEqual(['existing.txt']);
      } finally {
        setMockArchonHome(originalHome);
        await removeTempTree(home);
      }
    }
  );

  for (const firstIngress of ['message', 'workflow'] as const) {
    for (const queuedIngress of ['message', 'workflow'] as const) {
      test(`preserves queued ${queuedIngress} uploads after ${firstIngress} cleanup`, async () => {
        const originalHome = mockArchonHome;
        const home = await mkdtemp(join(tmpdir(), 'archon-queued-uploads-'));
        setMockArchonHome(home);
        const lockManager = new ConversationLockManager();
        const waitForIdle = async () => {
          const deadline = Date.now() + 5000;
          while (lockManager.getStats().active > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          expect(lockManager.getStats().active).toBe(0);
        };
        const releaseFirst = Promise.withResolvers<void>();
        const releaseQueued = Promise.withResolvers<void>();
        const queuedRead = Promise.withResolvers<string>();
        const paths: string[] = [];
        mockFindConversationByPlatformId.mockResolvedValue(MOCK_CONV);
        mockHandleMessage.mockImplementation(async (_adapter, _id, message, context) => {
          const file = context.attachedFiles?.[0];
          if (!file) throw new Error('Expected an attachment');
          paths.push(file.path);
          if (message === 'first') {
            await releaseFirst.promise;
          } else {
            try {
              queuedRead.resolve(await fsPromises.readFile(file.path, 'utf8'));
            } catch (error) {
              queuedRead.reject(error);
            }
            await releaseQueued.promise;
          }
        });
        try {
          const { app } = makeApp(lockManager);
          const send = (ingress: 'message' | 'workflow', message: string) => {
            const form = new FormData();
            form.set('conversationId', 'web-test-abc');
            form.set('message', message);
            form.set('files', new File([message], 'request.txt', { type: 'text/plain' }));
            return app.request(
              ingress === 'message'
                ? '/api/conversations/web-test-abc/message'
                : '/api/workflows/deploy/run',
              { method: 'POST', body: form }
            );
          };
          const first = await send(firstIngress, 'first');
          expect(await first.json()).toEqual({ accepted: true, status: 'started' });
          const queued = await send(queuedIngress, 'queued');
          expect(await queued.json()).toEqual({ accepted: true, status: 'queued-conversation' });
          const uploadDir = join(home, 'artifacts', 'uploads', 'web-test-abc');
          expect(await fsPromises.readdir(uploadDir)).toHaveLength(2);
          releaseFirst.resolve();
          expect(await queuedRead.promise).toBe('queued');
          expect(paths).toHaveLength(2);
          expect(await Bun.file(paths[0] ?? '').exists()).toBe(false);
          expect(await fsPromises.readdir(uploadDir)).toHaveLength(1);
          releaseQueued.resolve();
          await waitForIdle();
          expect(await fsPromises.readdir(uploadDir)).toEqual([]);
        } finally {
          releaseFirst.resolve();
          releaseQueued.resolve();
          await waitForIdle();
          setMockArchonHome(originalHome);
          await removeTempTree(home);
        }
      });
    }
  }

  test('fires title generation for conversations without title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => ({
      ...MOCK_CONV,
      title: null,
    }));
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockGenerateAndSetTitle).toHaveBeenCalledWith(
      MOCK_CONV.id,
      'Deploy',
      { provider: 'claude', options: {} },
      expect.any(String),
      undefined,
      'deploy'
    );
  });

  test('returns 400 when conversationId is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Deploy to staging' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 when message is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('message');
  });

  test('returns 400 for invalid workflow name (path traversal)', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/../secret/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Test' }),
    });
    // Hono routes won't match ../secret as /:name due to path normalization — either 400 or 404
    expect([400, 404]).toContain(response.status);
  });

  test('returns 400 when isValidWorkflowName rejects the name', async () => {
    const { isValidWorkflowName } = await import('@archon/workflows/command-validation');
    (isValidWorkflowName as ReturnType<typeof mock>).mockReturnValueOnce(false);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/.hidden/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Test' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON in request body' });
  });

  // -------------------------------------------------------------------------
  // Declared inputs (#2554)
  // -------------------------------------------------------------------------

  test('forwards a JSON `inputs` map on the context, never in the message text', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Review it',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/review-block/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'web-test-abc',
        message: 'Review it',
        inputs: { diff: 'D1', style: 'terse' },
      }),
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      // The message is untouched — a supplied value must never be confusable
      // with $ARGUMENTS, and this route must not invent a chat grammar.
      'Review it',
      expect.objectContaining({ workflowInputs: { diff: 'D1', style: 'terse' } })
    );
  });

  test('omits workflowInputs entirely when no inputs are supplied', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Go',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go' }),
    });

    const ctx = mockHandleMessage.mock.calls[0]?.[3];
    expect(ctx).not.toHaveProperty('workflowInputs');
  });

  test('returns 400 when `inputs` is not an object of strings', async () => {
    const { app } = makeApp();
    for (const inputs of [['a'], 'nope', { diff: 5 }, { diff: null }]) {
      const response = await app.request('/api/workflows/deploy/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', inputs }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe(
        typeof inputs === 'object' && !Array.isArray(inputs)
          ? "inputs value for 'diff' must be a string"
          : 'inputs must be an object mapping input names to strings'
      );
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('treats an explicit empty `inputs` object as nothing supplied', async () => {
    // `{}` is valid, not an error — it means "take every declared default", so the
    // context must carry no workflowInputs rather than an empty map.
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Go',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', inputs: {} }),
    });
    expect(response.status).toBe(200);

    const ctx = mockHandleMessage.mock.calls[0]?.[3];
    expect(ctx).not.toHaveProperty('workflowInputs');
  });

  test('accepts a multipart `inputs` field carrying the map JSON-encoded', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Review it',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Review it');
    form.append('inputs', JSON.stringify({ diff: 'D1' }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/review-block/run', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      'Review it',
      expect.objectContaining({ workflowInputs: { diff: 'D1' } })
    );
  });

  test('returns 400 for a malformed multipart `inputs` field rather than dropping it', async () => {
    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Review it');
    form.append('inputs', 'not json {{{');

    const { app } = makeApp();
    const response = await app.request('/api/workflows/review-block/run', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'inputs must be a JSON-encoded object of string values',
    });
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('forwards sparse JSON tier and alias bindings as structured context', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockHandleMessage.mockImplementationOnce(async () => {});
    const { app } = makeApp();
    const response = await app.request('/api/workflows/bench/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'web-test-abc',
        message: 'Go',
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      'Go',
      expect.objectContaining({
        workflowModelOverrides: {
          tiers: { large: 'openai/gpt-5.6' },
          aliases: { '@planner': 'codex/gpt-5.6-sol' },
        },
      })
    );
  });

  test('accepts multipart tier and alias maps as JSON object fields', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockHandleMessage.mockImplementationOnce(async () => {});
    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Go');
    form.append('tiers', JSON.stringify({ large: 'openai/gpt-5.6' }));
    form.append('aliases', JSON.stringify({ '@planner': 'codex/gpt-5.6-sol' }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/bench/run', {
      method: 'POST',
      body: form,
    });

    expect(response.status).toBe(200);
    const context = mockHandleMessage.mock.calls[0]?.[3];
    expect(context?.workflowModelOverrides).toEqual({
      tiers: { large: 'openai/gpt-5.6' },
      aliases: { '@planner': 'codex/gpt-5.6-sol' },
    });
  });

  test('rejects malformed model binding maps before dispatch', async () => {
    const { app } = makeApp();
    for (const payload of [
      { tiers: { tiny: 'x' } },
      { tiers: { large: 5 } },
      { aliases: { planner: 'x' } },
      { aliases: ['@planner=x'] },
    ]) {
      const response = await app.request('/api/workflows/bench/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', ...payload }),
      });
      expect(response.status).toBe(400);
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  for (const assistantField of ['assistant', 'defaultAssistant'] as const) {
    test.each(['json', 'multipart'])(
      `forwards schema-valid %s config using ${assistantField}`,
      async transport => {
        mockFindConversationByPlatformId.mockResolvedValue(null);
        mockHandleMessage.mockResolvedValue(undefined);
        const config = {
          [assistantField]: 'pi',
          assistants: { pi: {} },
          tiers: { small: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
          aliases: { '@planner': { provider: 'pi', model: 'minimax/MiniMax-M3' } },
          docs: { path: 'handbook' },
          env: { BENCH_TOKEN: 'test-token' },
          workflows: { autoResumeOnQuotaReset: false },
        };
        expect(Object.keys(config).sort()).toEqual(
          workflowRunConfigKeys
            .filter(
              key => key !== (assistantField === 'assistant' ? 'defaultAssistant' : 'assistant')
            )
            .sort()
        );
        const payload = {
          conversationId: 'web-test-abc',
          message: 'Go',
          inputs: { diff: 'D1' },
          tiers: { large: 'pi/minimax/MiniMax-M3' },
          aliases: { '@reviewer': 'pi/minimax/MiniMax-M3' },
          config,
        };
        workflowRunLaunchJsonSchema.parse(payload);
        const { app } = makeApp();
        let response: Response;
        if (transport === 'json') {
          response = await app.request('/api/workflows/bench/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } else {
          const fields = {
            ...payload,
            inputs: JSON.stringify(payload.inputs),
            tiers: JSON.stringify(payload.tiers),
            aliases: JSON.stringify(payload.aliases),
            config: JSON.stringify(config),
          };
          workflowRunLaunchMultipartSchema.parse(fields);
          const form = new FormData();
          for (const [name, value] of Object.entries(fields)) form.set(name, value);
          response = await app.request('/api/workflows/bench/run', { method: 'POST', body: form });
        }
        expect(response.status).toBe(200);
        expect(mockHandleMessage.mock.calls[0]?.[3]).toMatchObject({
          workflowInputs: payload.inputs,
          workflowModelOverrides: { tiers: payload.tiers, aliases: payload.aliases },
        });
        expect(mockHandleMessage.mock.calls[0]?.[3]?.workflowRunConfig).toEqual({
          source: { kind: 'http', label: 'inline' },
          layer: {
            assistant: 'pi',
            assistants: config.assistants,
            tiers: config.tiers,
            aliases: config.aliases,
            docsPath: 'handbook',
            envVars: config.env,
            workflows: config.workflows,
          },
        });
      }
    );
  }

  test.each([
    [{ docsPath: 'handbook' }, "Unknown run config key 'docsPath'"],
    [{ envVars: { TOKEN: 'test' } }, "Unknown run config key 'envVars'"],
    [{ layer: {} }, "Unknown run config key 'layer'"],
    [{ docs: { unexpected: true } }, "Unknown run config key 'docs.unexpected'"],
    [{ env: { TOKEN: 7 } }, "Invalid run config at 'envVars.TOKEN'"],
    [{ tiers: { small: 'pi/model' } }, "Invalid run config at 'tiers.small'"],
  ])('raw config schema and parser refuse %j', async (config, error) => {
    expect(workflowRunLaunchConfigSchema.safeParse(config).success).toBe(false);
    const { app } = makeApp();
    for (const transport of ['json', 'multipart']) {
      const form = new FormData();
      form.set('conversationId', 'web-test-abc');
      form.set('message', 'Go');
      form.set('config', JSON.stringify(config));
      const response = await app.request(
        '/api/workflows/bench/run',
        transport === 'json'
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', config }),
            }
          : { method: 'POST', body: form }
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining(error) });
    }
    expect(mockFindConversationByPlatformId).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('rejects caller-supplied server paths and ineffective config before dispatch', async () => {
    const { app } = makeApp();
    const invalidConfigs = [
      [{ configPath: '/etc/passwd' }, 'configPath is not supported'],
      [{ config: null }, "Invalid run config at 'document'"],
      [{ config: { paths: { worktrees: '/tmp/other' } } }, "Unknown run config key 'paths'"],
      [{ config: { unknown: true } }, "Unknown run config key 'unknown'"],
      [
        { config: { assistant: 'pi', defaultAssistant: 'pi' } },
        "Run config cannot set both 'assistant' and 'defaultAssistant'; use one spelling.",
      ],
    ] as const;
    for (const [payload, expectedError] of invalidConfigs) {
      const response = await app.request('/api/workflows/bench/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', ...payload }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(expectedError),
      });
    }
    for (const [payload, expectedError] of invalidConfigs) {
      const form = new FormData();
      form.append('conversationId', 'web-test-abc');
      form.append('message', 'Go');
      if ('configPath' in payload) form.append('configPath', payload.configPath);
      if ('config' in payload) form.append('config', JSON.stringify(payload.config));
      const response = await app.request('/api/workflows/bench/run', {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(expectedError),
      });
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('forwards one JSON continuation run id and refuses an invalid declaration', async () => {
    mockFindConversationByPlatformId.mockImplementation(async () => null);
    mockHandleMessage.mockImplementation(async () => {});
    const { app } = makeApp();
    const run = async (extra: Record<string, unknown>): Promise<Response> =>
      app.request('/api/workflows/deploy/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', ...extra }),
      });

    expect((await run({ adopt_run_id: 'run-1' })).status).toBe(200);
    expect((await run({ supersedes_run_id: 'run-2' })).status).toBe(200);
    const [adoptCtx, supersedeCtx] = mockHandleMessage.mock.calls.map(call => call[3]);
    expect(adoptCtx).toMatchObject({ workflowAdoptRunId: 'run-1' });
    expect(adoptCtx).not.toHaveProperty('workflowSupersedesRunId');
    expect(supersedeCtx).toMatchObject({ workflowSupersedesRunId: 'run-2' });
    expect(supersedeCtx).not.toHaveProperty('workflowAdoptRunId');

    mockHandleMessage.mockClear();
    for (const [extra, error] of [
      [{ adopt_run_id: '' }, 'adopt_run_id must be a non-empty run id'],
      [{ supersedes_run_id: 7 }, 'supersedes_run_id must be a non-empty run id'],
      [
        { adopt_run_id: 'run-1', supersedes_run_id: 'run-2' },
        'adopt_run_id and supersedes_run_id are mutually exclusive',
      ],
    ] as const) {
      const response = await run(extra);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });
});
