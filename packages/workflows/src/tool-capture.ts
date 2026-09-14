import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { MessageChunk } from '@archon/providers/types';

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 16 * MAX_RESULT_BYTES;
const MAX_CALLS = 256;

export const captureProducerSchema = z
  .object({
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    attempt: z.uuid(),
    iteration: z.number().int().positive().nullable(),
  })
  .strict();
export const captureOwnerSchema = captureProducerSchema.pick({ runId: true, nodeId: true });
const fileSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export const toolReceiptSchema = z
  .object({
    version: z.literal(1),
    producer: captureProducerSchema,
    callId: z.string().min(1),
    tool: z.string().min(1),
    outcome: z.enum(['success', 'error', 'interrupted', 'unknown']),
    exitCode: z.number().int().optional(),
    completeness: z.enum(['full', 'truncated', 'redacted', 'unavailable']),
    truncated: z.boolean(),
    redacted: z.boolean(),
    format: z.enum(['text', 'json']),
    output: fileSchema,
    attachments: z.array(fileSchema.extend({ mediaType: z.string().min(1) })),
  })
  .strict();
export const toolCaptureManifestSchema = z
  .object({
    version: z.literal(2),
    directory: z.string().min(1),
    owner: captureOwnerSchema,
    passes: z
      .array(
        z
          .object({
            producer: captureProducerSchema,
            complete: z.boolean(),
            receipts: z.array(fileSchema).max(MAX_CALLS),
          })
          .strict()
      )
      .max(MAX_CALLS),
  })
  .strict();
export type ToolReceipt = z.infer<typeof toolReceiptSchema>;
export type ToolCaptureManifest = z.infer<typeof toolCaptureManifestSchema>;
export type CaptureFile = z.infer<typeof fileSchema>;

export function captureHash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function readCaptureFile(root: string, file: CaptureFile): Promise<Buffer> {
  const path = resolve(root, file.path);
  if (
    isAbsolute(file.path) ||
    !inside(root, path) ||
    !inside(await realpath(root), await realpath(path))
  ) {
    throw new Error('capture reference escapes its owner');
  }
  const bytes = await readFile(path);
  if (bytes.length !== file.bytes || captureHash(bytes) !== file.sha256) {
    throw new Error('capture bytes do not match their receipt');
  }
  return bytes;
}

export async function readToolCaptures(
  directory: string,
  runId: string
): Promise<{
  manifest: ToolCaptureManifest;
  manifestFile: CaptureFile;
  receipts: {
    pass: ToolCaptureManifest['passes'][number];
    reference: CaptureFile;
    receipt: ToolReceipt;
  }[];
}> {
  const root = await realpath(directory);
  if (!inside(root, await realpath(join(root, 'manifest.json'))))
    throw new Error('capture manifest escapes its owner');
  const bytes = await readFile(join(root, 'manifest.json'));
  const manifest = toolCaptureManifestSchema.parse(JSON.parse(bytes.toString()) as unknown);
  if (manifest.directory !== root || manifest.owner.runId !== runId) {
    throw new Error('capture manifest has the wrong owner');
  }
  const receipts = [];
  let retainedBytes = 0;
  for (const pass of manifest.passes) {
    if (
      pass.producer.runId !== manifest.owner.runId ||
      pass.producer.nodeId !== manifest.owner.nodeId
    ) {
      throw new Error('capture pass has the wrong owner');
    }
    const callIds = new Set<string>();
    for (const reference of pass.receipts) {
      const receipt = toolReceiptSchema.parse(
        JSON.parse((await readCaptureFile(root, reference)).toString()) as unknown
      );
      if (
        JSON.stringify(receipt.producer) !== JSON.stringify(pass.producer) ||
        callIds.has(receipt.callId)
      ) {
        throw new Error('capture receipt has the wrong producer or duplicate call within a pass');
      }
      callIds.add(receipt.callId);
      await readCaptureFile(root, receipt.output);
      for (const attachment of receipt.attachments) await readCaptureFile(root, attachment);
      const resultBytes =
        receipt.output.bytes + receipt.attachments.reduce((sum, file) => sum + file.bytes, 0);
      if (resultBytes > MAX_RESULT_BYTES)
        throw new Error('tool capture result exceeds its byte limit');
      retainedBytes += resultBytes;
      receipts.push({ pass, reference, receipt });
    }
  }
  if (receipts.length > MAX_CALLS) throw new Error('tool capture call limit exceeded');
  if (retainedBytes > MAX_CAPTURE_BYTES)
    throw new Error('tool capture directory exceeds its byte limit');
  return {
    manifest,
    receipts,
    manifestFile: {
      path: 'manifest.json',
      sha256: captureHash(bytes),
      bytes: bytes.length,
    },
  };
}

export class ToolCaptureSession {
  private retainedBytes = 0;
  private sequence = 0;
  private readonly pending = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly pass: ToolCaptureManifest['passes'][number];

  private constructor(
    private readonly directory: string,
    private readonly manifest: ToolCaptureManifest,
    readonly producer: z.infer<typeof captureProducerSchema>,
    retainedBytes: number,
    private readonly retainedCallCount: number
  ) {
    this.retainedBytes = retainedBytes;
    this.pass = { producer: this.producer, complete: false, receipts: [] };
    this.manifest.passes.push(this.pass);
  }

  static async create(
    root: string,
    directory: string,
    runId: string,
    nodeId: string,
    iteration?: number
  ): Promise<ToolCaptureSession> {
    const owner = await realpath(root);
    const target = resolve(directory);
    if (!inside(owner, target)) throw new Error('capture directory must be inside run artifacts');
    let ancestor = target;
    while (true) {
      try {
        const canonical = await realpath(ancestor);
        if (canonical !== owner && !inside(owner, canonical))
          throw new Error('capture directory escapes run artifacts');
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        ancestor = dirname(ancestor);
      }
    }
    await mkdir(target, { recursive: true });
    const canonical = await realpath(target);
    if (!inside(owner, canonical)) throw new Error('capture directory escapes run artifacts');
    let manifest: ToolCaptureManifest;
    let retainedBytes = 0;
    let completedCalls = 0;
    try {
      const captured = await readToolCaptures(canonical, runId);
      manifest = captured.manifest;
      if (manifest.owner.nodeId !== nodeId)
        throw new Error('capture directory belongs to another node');
      completedCalls = captured.receipts.length;
      retainedBytes = captured.receipts.reduce(
        (total, entry) =>
          total +
          entry.receipt.output.bytes +
          entry.receipt.attachments.reduce((sum, file) => sum + file.bytes, 0),
        0
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      manifest = { version: 2, directory: canonical, owner: { runId, nodeId }, passes: [] };
    }
    if (manifest.passes.length >= MAX_CALLS) throw new Error('tool capture pass limit exceeded');
    const producer = { runId, nodeId, attempt: randomUUID(), iteration: iteration ?? null };
    const session = new ToolCaptureSession(
      canonical,
      manifest,
      producer,
      retainedBytes,
      completedCalls
    );
    await mkdir(join(canonical, producer.attempt));
    await session.saveManifest();
    return session;
  }

  private async atomic(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  }

  private async saveManifest(): Promise<void> {
    await this.atomic(
      join(this.directory, 'manifest.json'),
      Buffer.from(JSON.stringify(this.manifest))
    );
  }

  private async file(name: string, bytes: Uint8Array): Promise<CaptureFile> {
    const path = `${this.pass.producer.attempt}/${name}`;
    await this.atomic(join(this.directory, path), bytes);
    return { path, bytes: bytes.byteLength, sha256: captureHash(bytes) };
  }

  private async result(
    message: Extract<MessageChunk, { type: 'tool_result' }>,
    secrets: readonly string[]
  ): Promise<void> {
    const matching = [...this.pending].filter(([, tool]) => tool === message.toolName);
    const id = message.toolCallId ?? (matching.length === 1 ? matching[0]?.[0] : undefined);
    if (id === undefined || this.pending.get(id) !== message.toolName || this.completed.has(id)) {
      throw new Error('capture result has no unique matching tool call');
    }
    this.pending.delete(id);
    this.completed.add(id);
    if (this.retainedCallCount + this.completed.size > MAX_CALLS)
      throw new Error('tool capture call limit exceeded');
    const capture = message.capture;
    let text = capture?.text ?? '';
    let tool = message.toolName;
    for (const secret of secrets)
      if (secret !== '') {
        text = text
          .replaceAll(secret, '[REDACTED]')
          .replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
        tool = tool.replaceAll(secret, '[REDACTED]');
      }
    let redacted =
      tool !== message.toolName ||
      (text !== capture?.text && capture !== undefined) ||
      capture?.completeness === 'redacted';
    const raw = Buffer.from(text);
    const budget = Math.min(MAX_RESULT_BYTES, MAX_CAPTURE_BYTES - this.retainedBytes);
    const retained = raw.subarray(0, budget);
    let truncated = retained.length !== raw.length || capture?.completeness === 'truncated';
    this.retainedBytes += retained.length;
    let resultBytes = retained.length;
    const serial = String(this.retainedCallCount + this.completed.size);
    const attachments: ToolReceipt['attachments'] = [];
    for (const attachment of capture?.attachments ?? []) {
      if (
        redacted ||
        attachment.data.byteLength >
          Math.min(MAX_RESULT_BYTES - resultBytes, MAX_CAPTURE_BYTES - this.retainedBytes)
      ) {
        truncated = true;
        continue;
      }
      // Binary attachments cannot be text-redacted safely. Reject known secret bytes
      // instead of keeping a subtly modified image that still claims completeness.
      if (
        secrets.some(
          secret => secret !== '' && Buffer.from(attachment.data).includes(Buffer.from(secret))
        )
      ) {
        redacted = true;
        continue;
      }
      const file = await this.file(`${serial}-${attachments.length}.bin`, attachment.data);
      this.retainedBytes += file.bytes;
      resultBytes += file.bytes;
      attachments.push({ ...file, mediaType: attachment.mediaType });
    }
    const receipt: ToolReceipt = {
      version: 1,
      producer: this.pass.producer,
      callId: id,
      tool,
      outcome: message.toolOutcome ?? 'unknown',
      ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
      completeness:
        capture === undefined || capture.completeness === 'unavailable'
          ? 'unavailable'
          : redacted
            ? 'redacted'
            : truncated
              ? 'truncated'
              : 'full',
      truncated,
      redacted,
      format: capture?.format ?? 'text',
      output: await this.file(`${serial}.output`, retained),
      attachments,
    };
    this.pass.receipts.push(
      await this.file(`${serial}.json`, Buffer.from(JSON.stringify(receipt)))
    );
    await this.saveManifest();
  }

  async *retain(
    stream: AsyncIterable<MessageChunk>,
    secrets: readonly string[]
  ): AsyncGenerator<MessageChunk> {
    let result = false;
    const finish = async (terminal: boolean): Promise<void> => {
      const missing = this.pending.size > 0;
      for (const [callId, tool] of this.pending) {
        await this.result(
          {
            type: 'tool_result',
            toolName: tool,
            toolCallId: callId,
            toolOutput: '',
            toolOutcome: 'unknown',
          },
          secrets
        );
      }
      this.pass.complete = terminal && !missing;
      await this.saveManifest();
    };
    try {
      for await (const message of stream) {
        if (message.type === 'tool') {
          const id = message.toolCallId ?? `anonymous-${++this.sequence}`;
          if (this.pending.has(id) || this.completed.has(id))
            throw new Error('duplicate capture call id');
          if (this.retainedCallCount + this.pending.size + this.completed.size >= MAX_CALLS)
            throw new Error('tool capture call limit exceeded');
          this.pending.set(id, message.toolName);
        } else if (message.type === 'tool_result') {
          await this.result(message, secrets);
        } else if (message.type === 'result') {
          // Executors stop at the provider's terminal result without draining its
          // process. Commit required writes before exposing that completion signal.
          await finish(message.isError !== true);
          result = true;
        }
        if (message.type === 'tool_result') {
          const presentation = { ...message };
          delete presentation.capture;
          yield presentation;
        } else yield message;
      }
    } finally {
      if (!result) await finish(false);
    }
  }
}
