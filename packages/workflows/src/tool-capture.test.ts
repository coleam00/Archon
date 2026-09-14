import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { MessageChunk } from '@archon/providers/types';
import { captureToolResult } from '../../providers/src/shared/tool-capture';
import { captureHash, readToolCaptures, ToolCaptureSession } from './tool-capture';

const track = trackTempRoots();
async function root(): Promise<string> {
  return track(await mkdtemp(join(tmpdir(), 'capture-')));
}
async function* stream(messages: MessageChunk[]): AsyncGenerator<MessageChunk> {
  yield* messages;
}
async function drain(messages: AsyncIterable<MessageChunk>): Promise<void> {
  for await (const message of messages) void message;
}
function events(text = ''): MessageChunk[] {
  return [
    { type: 'tool', toolName: 'shell', toolCallId: 'call-1' },
    {
      type: 'tool_result',
      toolName: 'shell',
      toolCallId: 'call-1',
      toolOutput: 'display only',
      toolOutcome: 'error',
      exitCode: 1,
      capture: captureToolResult(text),
    },
    { type: 'result' },
  ];
}

describe('durable provider tool captures', () => {
  it('retains empty output and negative-command status separately from assertion outcome', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'attempt');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify', 2);
    await drain(capture.retain(stream(events()), []));
    const { receipts, manifest } = await readToolCaptures(directory, 'run');
    expect(manifest.passes[0]?.producer).toMatchObject({
      runId: 'run',
      nodeId: 'verify',
      iteration: 2,
    });
    expect(receipts[0]?.receipt).toMatchObject({
      completeness: 'full',
      outcome: 'error',
      exitCode: 1,
      output: { bytes: 0, sha256: captureHash('') },
    });
  });

  it('redacts known credential values before retention and exposes bounded truncation', async () => {
    for (const [text, expected] of [
      ['secret-value false 0', 'redacted'],
      ['x'.repeat(1024 * 1024 + 1), 'truncated'],
    ] as const) {
      const artifacts = await root();
      const directory = join(artifacts, 'attempt');
      const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
      await drain(capture.retain(stream(events(text)), ['secret-value']));
      const { receipts } = await readToolCaptures(directory, 'run');
      const receipt = receipts[0]!.receipt;
      expect(receipt.completeness).toBe(expected);
      expect(receipt.output.bytes).toBeLessThanOrEqual(1024 * 1024);
      const retained = await readFile(join(directory, receipt.output.path), 'utf8');
      expect(retained).not.toContain('secret-value');
      if (expected === 'redacted') expect(retained).toBe('[REDACTED] false 0');
    }
  });

  it('keeps provider completeness, missing data and interrupted outcomes explicit', async () => {
    for (const completeness of ['full', 'truncated', 'redacted', 'unavailable'] as const) {
      const artifacts = await root();
      const directory = join(artifacts, 'attempt');
      const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
      await drain(
        capture.retain(
          stream([
            { type: 'tool', toolName: 'browser', toolCallId: '1' },
            {
              type: 'tool_result',
              toolName: 'browser',
              toolCallId: '1',
              toolOutput: 'untrusted display',
              toolOutcome: 'interrupted',
              capture: { ...captureToolResult('false'), completeness },
            },
            { type: 'result' },
          ]),
          []
        )
      );
      expect((await readToolCaptures(directory, 'run')).receipts[0]?.receipt).toMatchObject({
        completeness,
        outcome: 'interrupted',
      });
    }
  });

  it('records missing closure and rejects interrupted or errored streams', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'attempt');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(
      capture.retain(
        stream([{ type: 'tool', toolName: 'shell', toolCallId: 'missing' }, { type: 'result' }]),
        []
      )
    );
    expect((await readToolCaptures(directory, 'run')).manifest.passes[0]?.complete).toBe(false);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      passes: Array<{ receipts: Array<{ path: string }> }>;
    };
    expect(
      JSON.parse(await readFile(join(directory, manifest.passes[0]!.receipts[0]!.path), 'utf8'))
    ).toMatchObject({ completeness: 'unavailable', outcome: 'unknown' });
  });

  it('propagates provider errors after persisting an incomplete manifest', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'attempt');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    async function* failing(): AsyncGenerator<MessageChunk> {
      yield { type: 'tool', toolName: 'shell' };
      throw new Error('provider disconnected');
    }
    await expect(drain(capture.retain(failing(), []))).rejects.toThrow('provider disconnected');
    expect((await readToolCaptures(directory, 'run')).manifest.passes[0]?.complete).toBe(false);
  });

  it('does not certify a failed terminal result even after tool output was retained', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(
      capture.retain(
        stream([...events('output').slice(0, 2), { type: 'result', isError: true }]),
        []
      )
    );
    expect((await readToolCaptures(directory, 'run')).manifest.passes[0]?.complete).toBe(false);
  });

  it('does not accept unrelated files, wrong owners, changed output or path escapes', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'attempt');
    await writeFile(join(artifacts, 'unrelated.txt'), 'nonempty diagnostic');
    await expect(readToolCaptures(artifacts, 'run')).rejects.toThrow();
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(capture.retain(stream(events('actual output')), []));
    const { receipts } = await readToolCaptures(directory, 'run');
    await expect(readToolCaptures(directory, 'other')).rejects.toThrow('wrong owner');
    await expect(
      ToolCaptureSession.create(artifacts, join(artifacts, '..', 'escape'), 'run', 'verify')
    ).rejects.toThrow('inside run');
    await writeFile(join(directory, receipts[0]!.receipt.output.path), 'tampered');
    await expect(readToolCaptures(directory, 'run')).rejects.toThrow('do not match');
  });

  it('persists actual image attachments with owned references and hashes', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'attempt');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    const image = Buffer.from('image fixture bytes');
    await drain(
      capture.retain(
        stream([
          { type: 'tool', toolName: 'browser', toolCallId: '1' },
          {
            type: 'tool_result',
            toolName: 'browser',
            toolCallId: '1',
            toolOutput: 'screenshot saved',
            capture: captureToolResult([
              { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
            ]),
          },
          { type: 'result' },
        ]),
        []
      )
    );
    const receipt = (await readToolCaptures(directory, 'run')).receipts[0]!.receipt;
    expect(receipt.attachments[0]).toMatchObject({
      bytes: image.length,
      sha256: captureHash(image),
      mediaType: 'image/png',
    });
    expect(await readFile(join(directory, receipt.attachments[0]!.path))).toEqual(image);
    await writeFile(join(directory, receipt.attachments[0]!.path), 'different');
    await expect(readToolCaptures(directory, 'run')).rejects.toThrow('do not match');
  });

  it('rejects protected credential bytes before writing a binary attachment', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    const secret = 'protected-binary-secret';
    await drain(
      capture.retain(
        stream([
          { type: 'tool', toolName: 'browser', toolCallId: '1' },
          {
            type: 'tool_result',
            toolName: 'browser',
            toolCallId: '1',
            toolOutput: 'display',
            capture: {
              ...captureToolResult('clean text'),
              attachments: [
                { data: Buffer.from(`prefix-${secret}-suffix`), mediaType: 'image/png' },
              ],
            },
          },
          { type: 'result' },
        ]),
        [secret]
      )
    );
    const receipt = (await readToolCaptures(directory, 'run')).receipts[0]!.receipt;
    expect(receipt).toMatchObject({ completeness: 'redacted', redacted: true, attachments: [] });
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile())
        expect(await readFile(join(entry.parentPath, entry.name), 'utf8')).not.toContain(secret);
    }
  });

  it('retains incomplete and successful passes with repeated provider call ids', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const interrupted = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify', 1);
    async function* disconnect(): AsyncGenerator<MessageChunk> {
      yield { type: 'tool', toolName: 'shell', toolCallId: 'same-id' };
      throw new Error('disconnected');
    }
    await expect(drain(interrupted.retain(disconnect(), []))).rejects.toThrow('disconnected');
    const successful = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify', 2);
    await drain(
      successful.retain(
        stream(
          events('second pass').map(message =>
            message.type === 'tool' || message.type === 'tool_result'
              ? { ...message, toolCallId: 'same-id' }
              : message
          )
        ),
        []
      )
    );
    const captured = await readToolCaptures(directory, 'run');
    expect(captured.manifest.passes.map(pass => pass.complete)).toEqual([false, true]);
    expect(
      captured.receipts.map(entry => [entry.pass.producer.iteration, entry.receipt.callId])
    ).toEqual([
      [1, 'same-id'],
      [2, 'same-id'],
    ]);
    expect(captured.receipts.map(entry => entry.receipt.output.path)).toHaveLength(2);
    await expect(
      ToolCaptureSession.create(artifacts, directory, 'run', 'other-node')
    ).rejects.toThrow('another node');
  });

  it.each([
    ['the same owner', 'verify'],
    ['an incompatible owner', 'other-node'],
  ] as const)('rejects an overlapping session from %s', async (_description, secondNodeId) => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const first = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');

    await expect(
      ToolCaptureSession.create(artifacts, directory, 'run', secondNodeId)
    ).rejects.toThrow('already has an active session');

    await drain(first.retain(stream(events('first pass')), []));
    const next = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(next.retain(stream(events('second pass')), []));
    expect((await readToolCaptures(directory, 'run')).manifest.passes).toHaveLength(2);
  });

  it('fails closed on a crash-left session lock', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    await mkdir(join(directory, '.capture-session.lock'), { recursive: true });

    await expect(ToolCaptureSession.create(artifacts, directory, 'run', 'verify')).rejects.toThrow(
      'already has an active session'
    );
  });

  it('releases session ownership after a provider exception', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const failed = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    async function* disconnect(): AsyncGenerator<MessageChunk> {
      yield { type: 'tool', toolName: 'shell', toolCallId: 'first' };
      throw new Error('provider disconnected');
    }
    await expect(drain(failed.retain(disconnect(), []))).rejects.toThrow('provider disconnected');

    const retry = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(retry.retain(stream(events('retry')), []));
    expect((await readToolCaptures(directory, 'run')).manifest.passes).toHaveLength(2);
  });

  it('enforces the byte budget across passes in one authored directory', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const megabyte = 'x'.repeat(1024 * 1024);
    for (let pass = 1; pass <= 17; pass += 1) {
      const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify', pass);
      await drain(capture.retain(stream(events(megabyte)), []));
    }
    const captured = await readToolCaptures(directory, 'run');
    expect(captured.receipts.reduce((sum, entry) => sum + entry.receipt.output.bytes, 0)).toBe(
      16 * 1024 * 1024
    );
    expect(captured.receipts.at(-1)?.receipt).toMatchObject({
      completeness: 'truncated',
      output: { bytes: 0 },
    });
  });

  it('fails the producer when capture persistence fails', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'attempt');
    await writeFile(directory, 'not a directory');
    await expect(
      ToolCaptureSession.create(artifacts, directory, 'run', 'verify')
    ).rejects.toThrow();
    const capture = await ToolCaptureSession.create(
      artifacts,
      join(artifacts, 'valid'),
      'run',
      'verify'
    );
    const manifest = JSON.parse(
      await readFile(join(artifacts, 'valid', 'manifest.json'), 'utf8')
    ) as { passes: Array<{ producer: { attempt: string } }> };
    await mkdir(join(artifacts, 'valid', manifest.passes[0]!.producer.attempt, '1.output'));
    await expect(drain(capture.retain(stream(events('output')), []))).rejects.toThrow();
    expect(
      (await readToolCaptures(join(artifacts, 'valid'), 'run')).manifest.passes[0]?.complete
    ).toBe(false);
  });

  it('withholds terminal completion if the final manifest cannot be committed', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    async function* blocked(): AsyncGenerator<MessageChunk> {
      yield* events('output').slice(0, 2);
      await rename(join(directory, 'manifest.json'), join(directory, 'previous.json'));
      await mkdir(join(directory, 'manifest.json'));
      yield { type: 'result' };
    }
    const delivered: MessageChunk['type'][] = [];
    const consume = async (): Promise<void> => {
      for await (const message of capture.retain(blocked(), [])) delivered.push(message.type);
    };
    await expect(consume()).rejects.toThrow();
    expect(delivered).toEqual(['tool', 'tool_result']);
  });

  it('rejects a receipt from another producer even when its new hash matches', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(capture.retain(stream(events('output')), []));
    const { receipts, manifest } = await readToolCaptures(directory, 'run');
    const { receipt, reference } = receipts[0]!;
    const bytes = Buffer.from(
      JSON.stringify({ ...receipt, producer: { ...receipt.producer, nodeId: 'developer' } })
    );
    await writeFile(join(directory, reference.path), bytes);
    manifest.passes[0]!.receipts[0] = {
      ...reference,
      bytes: bytes.length,
      sha256: captureHash(bytes),
    };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(readToolCaptures(directory, 'run')).rejects.toThrow('wrong producer');
  });

  it('rejects ambiguous anonymous results and redacts credentials in tool names', async () => {
    const artifacts = await root();
    const directory = join(artifacts, 'capture');
    const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
    await drain(
      capture.retain(
        stream(
          events('output').map(message =>
            message.type === 'tool' || message.type === 'tool_result'
              ? { ...message, toolName: 'shell secret-value' }
              : message
          )
        ),
        ['secret-value']
      )
    );
    expect((await readToolCaptures(directory, 'run')).receipts[0]?.receipt).toMatchObject({
      tool: 'shell [REDACTED]',
      redacted: true,
    });
    const ambiguous = await ToolCaptureSession.create(
      artifacts,
      join(artifacts, 'ambiguous'),
      'run',
      'verify'
    );
    await expect(
      drain(
        ambiguous.retain(
          stream([
            { type: 'tool', toolName: 'shell' },
            { type: 'tool', toolName: 'shell' },
            { type: 'tool_result', toolName: 'shell', toolOutput: 'which call?' },
          ]),
          []
        )
      )
    ).rejects.toThrow('no unique matching');
  });

  it.skipIf(process.platform !== 'win32')(
    'retains real PowerShell stdout omitted by transcription',
    async () => {
      const artifacts = await root();
      const transcript = join(artifacts, 'transcript.txt');
      const command = `& { Start-Transcript -LiteralPath '${transcript.replaceAll("'", "''")}' | Out-Null; [pscustomobject]@{ observation = 'durable-capture-marker' }; Stop-Transcript | Out-Null } | Format-Table`;
      const script = join(artifacts, 'observe.ps1');
      await writeFile(script, command);
      const child = Bun.spawn(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', script],
        {
          cwd: artifacts,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('durable-capture-marker');
      expect((await readFile(transcript, 'utf8')).includes('durable-capture-marker')).toBe(false);
      const directory = join(artifacts, 'capture');
      const capture = await ToolCaptureSession.create(artifacts, directory, 'run', 'verify');
      await drain(capture.retain(stream(events(stdout)), []));
      const receipt = (await readToolCaptures(directory, 'run')).receipts[0]!.receipt;
      expect(await readFile(join(directory, receipt.output.path), 'utf8')).toBe(stdout);
    }
  );
});
