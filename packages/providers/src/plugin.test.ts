import { diagnoseBinary } from './shared/binary-diagnostics';
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { trackTempRoots } from '@archon/paths/test-utils';
import { connectProvider } from '@archon/provider-contract/plugin';
import type { ProviderConfigParser } from '@archon/provider-contract';
import { descriptor as claude } from './claude/descriptor';
import { descriptor as codex } from './codex/descriptor';
import { descriptor as pi } from './community/pi/descriptor';
import { parseClaudeConfigStrict } from './claude/config';
import { parseCodexConfigStrict } from './codex/config';
import { parsePiConfigStrict } from './community/pi/config';

const trackTempRoot = trackTempRoots();
const providers = [
  {
    descriptor: claude,
    path: 'claude',
    parse: parseClaudeConfigStrict,
    valid: { model: 'sonnet', settingSources: ['project'], claudeBinaryPath: '/binary' },
    invalid: [{ settingSources: ['bad'] }, { claudeBinaryPath: '' }],
  },
  {
    descriptor: codex,
    path: 'codex',
    parse: parseCodexConfigStrict,
    valid: {
      model: 'gpt-5',
      modelReasoningEffort: 'high',
      webSearchMode: 'live',
      additionalDirectories: ['/repo'],
      codexBinaryPath: '/binary',
    },
    invalid: [
      { webSearchMode: 'bad' },
      { modelReasoningEffort: 'bad' },
      { additionalDirectories: [1] },
    ],
  },
  {
    descriptor: pi,
    path: 'community/pi',
    parse: parsePiConfigStrict,
    valid: {
      model: 'google/gemini',
      interactive: false,
      extensionFlags: { plan: true },
      nodes: { plan: { interactive: true } },
    },
    invalid: [
      { model: 'gemini' },
      { interactive: 'yes' },
      { nodes: { plan: { unknown: true } } },
      { extensionFlags: { plan: 1 } },
    ],
  },
];

for (const { descriptor, path, parse, valid, invalid } of providers) {
  test(`${descriptor.id} descriptor validates the strict parser's config fixtures in every scope`, () => {
    const parser: ProviderConfigParser = parse;
    for (const scope of ['install', 'run', 'snapshot'] as const) {
      const schema = z.fromJSONSchema(descriptor.config![scope]);
      const fixtures: Record<string, unknown>[] = [
        {},
        valid,
        { model: ' ' },
        { model: 1 },
        { unknown: true },
        ...invalid,
      ];
      if (descriptor.id === 'pi')
        fixtures.push(
          { env: { TOKEN: 'secret' }, maxConcurrent: 2 },
          { env: { TOKEN: 1 } },
          { maxConcurrent: 0 }
        );
      for (const fixture of fixtures) {
        let accepted = true;
        try {
          parser(fixture, scope);
        } catch {
          accepted = false;
        }
        expect({ scope, fixture, accepted: schema.safeParse(fixture).success }).toEqual({
          scope,
          fixture,
          accepted,
        });
      }
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ model: ' ' }).success).toBe(false);
      if (scope === 'snapshot') {
        const snapshot = parser(valid, scope);
        expect(snapshot).not.toHaveProperty(`${descriptor.id}BinaryPath`);
        expect(snapshot).not.toHaveProperty('settingSources');
        expect(snapshot).not.toHaveProperty('env');
        expect(snapshot).not.toHaveProperty('maxConcurrent');
      }
    }
  });

  test(`${descriptor.id} source plugin initializes with its descriptor and manifest`, async () => {
    const home = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-provider-plugin-')));
    await mkdir(join(home, 'pi'), { recursive: true });
    const child = spawn(
      process.execPath,
      ['--no-env-file', join(import.meta.dir, path, 'plugin.ts')],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, 'codex'),
          PI_CODING_AGENT_DIR: join(home, 'pi'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    const stderr = new Response(Readable.toWeb(child.stderr)).text();
    let client: Awaited<ReturnType<typeof connectProvider>> | undefined;
    try {
      client = await connectProvider({
        readable: Readable.toWeb(child.stdout),
        writable: Writable.toWeb(child.stdin),
      });
      expect(client.descriptor).toEqual(descriptor);
      const manifest: unknown = JSON.parse(
        await readFile(
          resolve(import.meta.dir, `../../../plugins/provider-${descriptor.id}/archon-plugin.json`),
          'utf8'
        )
      );
      expect(manifest).toMatchObject({
        kind: 'provider',
        executable: `archon-provider-${descriptor.id}`,
      });
    } finally {
      if (client) await client.close();
      else child.kill();
      expect({ exit: await closed, stderr: await stderr }).toEqual({ exit: 0, stderr: '' });
    }
  });
}

test('the public providers barrel has no provider SDK in its bundle graph', async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'index.ts')],
    target: 'bun',
    metafile: true,
  });
  expect(build.success).toBe(true);
  for (const file of Object.keys(build.metafile!.inputs)) {
    expect(file.replaceAll('\\', '/')).not.toMatch(
      /(?:@anthropic-ai\/claude-agent-sdk|@openai\/codex|@earendil-works\/pi-|@github\/copilot-sdk|@opencode-ai\/sdk)/
    );
  }
});

test('binary diagnostics report resolution failures with redacted evidence and skip SDK-owned resolution', async () => {
  const previous = process.env.ARCHON_P4_SECRET;
  process.env.ARCHON_P4_SECRET = 'diagnostic-secret';
  try {
    const failure = await diagnoseBinary('binary', 'Provider binary', () => {
      throw new Error('resolver failed: diagnostic-secret');
    });
    expect(failure.checks[0]).toMatchObject({
      status: 'fail',
      message: 'Provider binary could not resolve or spawn: resolver failed: [REDACTED]',
    });
    const absent = await diagnoseBinary('binary', 'Provider binary', async () => undefined);
    expect(absent.checks[0].status).toBe('skip');
  } finally {
    if (previous === undefined) delete process.env.ARCHON_P4_SECRET;
    else process.env.ARCHON_P4_SECRET = previous;
  }
});
