import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import type { MessageChunk, SendQueryOptions } from '../types';
import { ClaudeProvider } from './provider';

test(
  'native project-only guidance is observed without rewriting user configuration, including resume',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-guidance-')));
    const home = join(root, 'home');
    const config = join(home, '.claude');
    const project = join(root, 'project');
    const payloads: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/v1/messages') {
          expect(request.headers.get('x-api-key')).toBe('fixture-key');
          payloads.push(await request.text());
          return Response.json({
            id: `message-${String(payloads.length)}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'fixture done' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        }
        return Response.json(
          { error: { type: 'invalid_request_error', message: 'fixture endpoint' } },
          { status: 400 }
        );
      },
    });
    try {
      await mkdir(config, { recursive: true });
      await mkdir(join(project, '.git'), { recursive: true });
      const userFile = join(config, 'CLAUDE.md');
      const projectFile = join(project, 'AGENTS.md');
      await writeFile(userFile, 'USER-GUIDANCE-MARKER\n');
      await writeFile(
        join(config, 'settings.json'),
        JSON.stringify({ env: { NATIVE_CONFIG_MARKER: 'preserved' } })
      );
      await writeFile(join(project, 'CLAUDE.md'), 'Read @AGENTS.md\n');
      await writeFile(projectFile, 'PROJECT-GUIDANCE-MARKER\n');
      const files = [
        userFile,
        join(config, 'settings.json'),
        join(project, 'CLAUDE.md'),
        projectFile,
      ];
      const hashes = () =>
        Promise.all(
          files.map(async path =>
            new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex')
          )
        );
      const before = await hashes();
      const options: SendQueryOptions = {
        env: {
          HOME: home,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_API_KEY: 'fixture-key',
          CLAUDE_API_KEY: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          ANTHROPIC_AUTH_TOKEN: '',
          CLAUDE_CODE_USE_BEDROCK: '0',
          CLAUDE_CODE_USE_VERTEX: '0',
          CLAUDE_CODE_USE_FOUNDRY: '0',
          CLAUDE_CODE_USE_MANTLE: '0',
          CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
          CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        },
        model: 'claude-sonnet-4-5',
        nodeConfig: { nodeId: 'guidance' },
        abortSignal: AbortSignal.timeout(30000),
      };
      const provider = new ClaudeProvider();
      const run = (request: SendQueryOptions, resume?: string) =>
        Array.fromAsync(provider.sendQuery('Local fixture only.', project, resume, request));
      const observed = (chunks: MessageChunk[]) =>
        chunks.flatMap(chunk =>
          chunk.type === 'heartbeat' ? (chunk.instructionSources ?? []) : []
        );
      const normal = await run(options);
      expect(payloads.length).toBeGreaterThan(0);
      expect(
        payloads.every(
          body => body.includes('USER-GUIDANCE-MARKER') && body.includes('PROJECT-GUIDANCE-MARKER')
        )
      ).toBe(true);
      expect(observed(normal)).toEqual([userFile, join(project, 'CLAUDE.md'), projectFile]);
      expect(await hashes()).toEqual(before);
      payloads.length = 0;
      const projectOnly = { ...options, assistantConfig: { settingSources: ['project'] } };
      const clean = await run(projectOnly);
      expect(payloads.length).toBeGreaterThan(0);
      expect(
        payloads.every(
          body => !body.includes('USER-GUIDANCE-MARKER') && body.includes('PROJECT-GUIDANCE-MARKER')
        )
      ).toBe(true);
      expect(observed(clean)).toEqual([join(project, 'CLAUDE.md'), projectFile]);
      expect(await hashes()).toEqual(before);
      const session = clean.find(chunk => chunk.type === 'session');
      if (session?.type !== 'session') throw new Error('Fixture did not initialize a session');
      const laterFile = join(project, 'later.md');
      await writeFile(laterFile, 'UPDATED-GUIDANCE-MARKER\n');
      await writeFile(join(project, 'CLAUDE.md'), 'Read @AGENTS.md and @later.md\n');
      payloads.length = 0;
      const resumed = await run(projectOnly, session.sessionId);
      expect(observed(resumed)).toContain(laterFile);
      expect(observed(resumed)).not.toContain(userFile);
      expect(payloads.length).toBeGreaterThan(0);
      expect(
        payloads.every(
          body => !body.includes('USER-GUIDANCE-MARKER') && body.includes('UPDATED-GUIDANCE-MARKER')
        )
      ).toBe(true);
      expect((await hashes()).slice(0, 2)).toEqual(before.slice(0, 2));
    } finally {
      await server.stop(true);
      await removeTempTree(root);
    }
  },
  testTimeout(40000)
);
