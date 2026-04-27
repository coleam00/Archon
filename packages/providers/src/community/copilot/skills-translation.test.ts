import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: () => mockLogger,
}));

mock.module('./binary-resolver', () => ({
  resolveCopilotCliPath: async () => '/usr/local/bin/copilot',
}));

type SessionHandler = (event: Record<string, unknown>) => void;

let registeredHandlers: Record<string, SessionHandler[]> = {};
const mockSession = {
  sessionId: 'copilot-session-skills',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => undefined;
  }),
  sendAndWait: mock(async () => ({ data: { content: 'ok', messageId: 'm' } })),
  abort: mock(async () => undefined),
  disconnect: mock(async () => undefined),
};

const capturedSessionConfigs: Array<Record<string, unknown>> = [];
const mockCreateSession = mock(async (config: Record<string, unknown>) => {
  capturedSessionConfigs.push(config);
  return mockSession;
});

mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class MockCopilotClient {
    createSession = mockCreateSession;
    resumeSession = mock(async () => mockSession);
    stop = mock(async () => []);
  },
}));

import { CopilotProvider } from './provider';

async function collectChunks(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

let tmpRoot = '';
let workDir = '';
let originalHome: string | undefined;

describe('applySkills', () => {
  beforeEach(() => {
    registeredHandlers = {};
    capturedSessionConfigs.length = 0;
    mockCreateSession.mockClear();

    tmpRoot = mkdtempSync(join(tmpdir(), 'copilot-skills-'));
    workDir = join(tmpRoot, 'project');
    const home = join(tmpRoot, 'home');

    originalHome = process.env.HOME;
    process.env.HOME = home;

    // Stage:
    //   <workDir>/.agents/skills/alpha/SKILL.md
    //   <home>/.claude/skills/beta/SKILL.md
    const stage: Array<[string, string]> = [
      [join(workDir, '.agents', 'skills', 'alpha'), 'SKILL.md'],
      [join(home, '.claude', 'skills', 'beta'), 'SKILL.md'],
    ];
    for (const [dir, file] of stage) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), '# skill\n');
    }
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('omits skillDirectories when nodeConfig.skills is absent', async () => {
    await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, { model: 'gpt-5' })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    expect(cfg.skillDirectories).toBeUndefined();
  });

  test('resolves project + home skills to absolute paths', async () => {
    await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, {
        model: 'gpt-5',
        nodeConfig: { skills: ['alpha', 'beta'] },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    const dirs = cfg.skillDirectories as string[] | undefined;
    expect(dirs).toHaveLength(2);
    expect(dirs?.[0]).toContain(join('.agents', 'skills', 'alpha'));
    expect(dirs?.[1]).toContain(join('.claude', 'skills', 'beta'));
  });

  test('warns on missing skills but still attaches resolved ones', async () => {
    const chunks = await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, {
        model: 'gpt-5',
        nodeConfig: { skills: ['alpha', 'does-not-exist'] },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    const dirs = cfg.skillDirectories as string[] | undefined;
    expect(dirs).toHaveLength(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('does-not-exist'),
      })
    );
  });

  test('omits skillDirectories entirely when nothing resolves', async () => {
    await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, {
        model: 'gpt-5',
        nodeConfig: { skills: ['nope'] },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    expect(cfg.skillDirectories).toBeUndefined();
  });
});
