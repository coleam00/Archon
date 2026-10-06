import { z } from 'zod';
import { PROVIDER_PLUGIN_MAX_MESSAGE_BYTES } from './wire';

export interface ProviderPluginIO {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export class ProviderPluginProtocolError extends Error {
  constructor(
    public readonly provider: string,
    public readonly line: number,
    detail: string,
    options?: ErrorOptions,
    public readonly reason: 'invalid_message' | 'closed' = 'invalid_message'
  ) {
    super(`Provider plugin ${provider}, line ${String(line)}: ${detail}`, options);
    this.name = 'ProviderPluginProtocolError';
  }
}

export class ProviderPluginRemoteError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'ProviderPluginRemoteError';
  }
}

const idSchema = z.union([z.string(), z.number().int()]);
const rpcBase = { jsonrpc: z.literal('2.0') };
export const rpcMessageSchema = z.union([
  z.strictObject({
    ...rpcBase,
    id: idSchema,
    method: z.string().min(1),
    params: z.json().optional(),
  }),
  z.strictObject({ ...rpcBase, method: z.string().min(1), params: z.json().optional() }),
  z.strictObject({ ...rpcBase, id: idSchema, result: z.json() }),
  z.strictObject({
    ...rpcBase,
    id: idSchema.nullable(),
    error: z.object({ code: z.number().int(), message: z.string(), data: z.json().optional() }),
  }),
]);
type RpcMessage = z.infer<typeof rpcMessageSchema>;
type RequestHandler = (params: unknown) => unknown;
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class ProviderRpc {
  readonly done: Promise<void>;
  private readonly reader;
  private readonly writer;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly requests = new Map<string, RequestHandler>();
  private readonly notifications = new Map<string, (params: unknown) => void>();
  private readonly responding = new Set<Promise<void>>();
  private nextId = 0;
  private ended = false;
  private failure: Error | undefined;
  private line = 0;
  private closing: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  provider = 'uninitialized';

  constructor(io: ProviderPluginIO) {
    this.reader = io.readable.getReader();
    this.writer = io.writable.getWriter();
    this.done = this.read();
    // Consumers can be suspended at a yielded chunk when a transport fails.
    // Keep the failure on done and pending requests without an unhandled rejection.
    void this.done.catch(() => undefined);
  }

  handle(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }
  on(method: string, handler: (params: unknown) => void): void {
    this.notifications.set(method, handler);
  }
  error(detail: string, cause?: unknown): ProviderPluginProtocolError {
    return new ProviderPluginProtocolError(this.provider, this.line, detail, { cause });
  }
  parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw this.error(`invalid payload (${parsed.error.message})`, parsed.error);
    return parsed.data;
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(this.failure ?? this.error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch(error => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : this.error('request failed', error));
      });
    });
  }
  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params });
  }
  private async send(message: unknown): Promise<void> {
    const encoded = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (encoded.byteLength - 1 > PROVIDER_PLUGIN_MAX_MESSAGE_BYTES) {
      throw this.error('message exceeds maximum byte length');
    }
    const write = this.writes.then(async () => {
      try {
        await this.writer.write(encoded);
      } catch (cause) {
        throw new ProviderPluginProtocolError(
          this.provider,
          this.line,
          'stream write failed',
          { cause },
          'closed'
        );
      }
    });
    this.writes = write.catch(error => {
      this.fail(error);
      void this.reader.cancel(error).catch(() => undefined);
    });
    return write;
  }
  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : this.error('transport failed', error);
    this.failure ??= failure;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
  }
  private dispatch(message: RpcMessage): void {
    if ('method' in message) {
      if (!('id' in message)) {
        this.notifications.get(message.method)?.(message.params);
        return;
      }
      const handler = this.requests.get(message.method);
      const respond = async (): Promise<void> => {
        if (!handler) {
          await this.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Unsupported method: ${message.method}` },
          });
          return;
        }
        let response: unknown;
        try {
          response = { jsonrpc: '2.0', id: message.id, result: await handler(message.params) };
        } catch (error) {
          response = {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: error instanceof z.ZodError ? -32602 : -32603,
              message: error instanceof Error ? error.message : 'Provider request failed',
            },
          };
        }
        await this.send(response);
      };
      // Prompt requests must not block reading session/cancel notifications.
      const task = respond().catch(error => {
        this.fail(error);
        void this.reader.cancel(error).catch(() => undefined);
      });
      this.responding.add(task);
      void task.finally(() => {
        this.responding.delete(task);
      });
      return;
    }
    const pending = message.id === null ? undefined : this.pending.get(message.id);
    if (!pending) throw this.error('response has no matching request');
    if (message.id !== null) this.pending.delete(message.id);
    if ('error' in message)
      pending.reject(new ProviderPluginRemoteError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  }
  private async read(): Promise<void> {
    let parts: Uint8Array[] = [];
    let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (!this.ended) {
        const { value, done } = await this.reader.read();
        if (done) break;
        let start = 0;
        for (let index = 0; index <= value.length; index++) {
          const newline = index < value.length && value[index] === 10;
          if (!newline && index < value.length) continue;
          const part = value.subarray(start, index);
          bytes += part.byteLength;
          if (bytes > PROVIDER_PLUGIN_MAX_MESSAGE_BYTES)
            throw new ProviderPluginProtocolError(
              this.provider,
              this.line + 1,
              'message exceeds maximum byte length'
            );
          if (part.length) parts.push(part);
          if (newline) {
            this.line++;
            const line = new Uint8Array(bytes);
            let offset = 0;
            for (const piece of parts) {
              line.set(piece, offset);
              offset += piece.length;
            }
            let raw: unknown;
            try {
              raw = JSON.parse(decoder.decode(line));
            } catch (error) {
              throw this.error('malformed JSON or UTF-8', error);
            }
            this.dispatch(this.parse(rpcMessageSchema, raw));
            parts = [];
            bytes = 0;
          }
          start = index + 1;
        }
      }
      if (bytes)
        throw new ProviderPluginProtocolError(this.provider, this.line + 1, 'unterminated message');
      if (this.failure) throw this.failure;
      if (this.pending.size)
        throw new ProviderPluginProtocolError(
          this.provider,
          this.line,
          'connection ended with pending requests',
          undefined,
          'closed'
        );
      this.ended = true;
    } catch (cause) {
      const error =
        cause instanceof ProviderPluginProtocolError
          ? cause
          : new ProviderPluginProtocolError(
              this.provider,
              this.line,
              'stream read failed',
              { cause },
              'closed'
            );
      this.fail(error);
      throw error;
    }
  }
  async drain(): Promise<void> {
    await Promise.all(this.responding);
  }
  close(): Promise<void> {
    this.closing ??= this.closeStreams();
    return this.closing;
  }
  private async closeStreams(): Promise<void> {
    await this.writes;
    await this.writer.close().catch(() => undefined);
    this.writer.releaseLock();
    if (!this.ended) this.fail(this.error('connection closed'));
    await this.reader.cancel().catch(() => undefined);
    await this.done.catch(() => undefined);
    this.reader.releaseLock();
  }
}
