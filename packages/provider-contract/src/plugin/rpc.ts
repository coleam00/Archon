import { z } from 'zod';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
export const PLUGIN_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface PluginIO {
  readable: ReadableStream<Uint8Array> | NodeReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface PluginMessageEvidence {
  /** UTF-8 byte length of the offending line, excluding its newline. */
  readonly bytes: number;
  /** A method this reader handles, `<method> response` for a reply to one of its own requests, else `unknown`. */
  readonly message: string;
}

// `detail` and `evidence` are host-authored or built from schema vocabulary, never from text
// on the plugin's line, so a host may surface and log them. `cause` may quote the line.
export class PluginProtocolError extends Error {
  constructor(
    public readonly plugin: string,
    public readonly line: number,
    public readonly detail: string,
    options?: ErrorOptions,
    public readonly reason: 'invalid_message' | 'closed' = 'invalid_message',
    public readonly evidence?: PluginMessageEvidence
  ) {
    super(`Plugin ${plugin}, line ${String(line)}: ${detail}`, options);
    this.name = 'PluginProtocolError';
  }
}

// Built only from the plugin id and validated protocol values, so it is safe to surface,
// unlike remote error prose.
export class PluginProtocolMismatchError extends PluginProtocolError {
  constructor(
    plugin: string,
    line: number,
    public readonly hostProtocol: number | string,
    public readonly pluginProtocol: number | string
  ) {
    super(
      plugin,
      line,
      `plugin speaks protocol ${String(pluginProtocol)}; this Archon speaks protocol ${String(hostProtocol)}`
    );
    this.name = 'PluginProtocolMismatchError';
  }
}

export class PluginRemoteError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: z.infer<ReturnType<typeof z.json>>
  ) {
    super(message);
    this.name = 'PluginRemoteError';
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
  method: string;
  schema: z.ZodType | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const MAX_EXPLAINED_ISSUES = 5;

// Explains a validation failure as `path: code` per issue. Messages, received values and
// unrecognized key names are never read, and a path segment renders only when the schema
// declares it as a key; anything else, such as a record key from the line, renders as `*`.
function explainIssues(schema: z.ZodType, error: z.ZodError): string {
  const declared = new Set<string>();
  const collect = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if ('properties' in node && node.properties !== null && typeof node.properties === 'object')
      for (const key of Object.keys(node.properties)) declared.add(key);
    for (const child of Object.values(node)) collect(child);
  };
  collect(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
  const renderPath = (path: readonly PropertyKey[]): string => {
    let rendered = '';
    for (const segment of path) {
      if (typeof segment === 'number') rendered += `[${String(segment)}]`;
      else {
        const name = typeof segment === 'string' && declared.has(segment) ? segment : '*';
        rendered += rendered ? `.${name}` : name;
      }
    }
    return rendered || '<root>';
  };
  const explained: string[] = [];
  const walk = (issues: readonly z.core.$ZodIssue[], base: readonly PropertyKey[]): void => {
    for (const issue of issues) {
      const path = [...base, ...issue.path];
      // Nested union issue paths are relative to the union; the branch with the fewest
      // issues is the one the value most nearly matched.
      if (issue.code === 'invalid_union' && issue.errors.length) {
        walk(
          issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best)),
          path
        );
        continue;
      }
      explained.push(
        `${renderPath(path)}: ${issue.code}${issue.code === 'invalid_type' ? `, expected ${issue.expected}` : ''}`
      );
    }
  };
  walk(error.issues, []);
  const shown = explained.slice(0, MAX_EXPLAINED_ISSUES).join('; ');
  return explained.length > MAX_EXPLAINED_ISSUES
    ? `${shown}; +${String(explained.length - MAX_EXPLAINED_ISSUES)} more`
    : shown;
}

export class PluginRpc {
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
  // The line being handled, so errors raised while handling it carry its evidence.
  private reading: PluginMessageEvidence | undefined;
  private closing: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  plugin = 'uninitialized';

  constructor(io: PluginIO) {
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
  error(detail: string, cause?: unknown): PluginProtocolError {
    return new PluginProtocolError(
      this.plugin,
      this.line,
      detail,
      { cause },
      'invalid_message',
      this.reading
    );
  }
  mismatch(
    hostProtocol: number | string,
    pluginProtocol: number | string
  ): PluginProtocolMismatchError {
    return new PluginProtocolMismatchError(this.plugin, this.line, hostProtocol, pluginProtocol);
  }
  parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw this.invalidPayload(schema, parsed.error);
    return parsed.data;
  }
  private invalidPayload(schema: z.ZodType, error: z.ZodError): PluginProtocolError {
    return this.error(`invalid payload (${explainIssues(schema, error)})`, error);
  }
  /** With a schema, the response is validated while its line is read, so a failure carries that line's evidence. */
  request(method: string, params: unknown): Promise<unknown>;
  request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T>;
  request(method: string, params: unknown, schema?: z.ZodType): Promise<unknown> {
    if (this.ended) return Promise.reject(this.failure ?? this.error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, schema, resolve, reject });
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
    if (encoded.byteLength - 1 > PLUGIN_MAX_MESSAGE_BYTES) {
      throw this.error('message exceeds maximum byte length');
    }
    const write = this.writes.then(async () => {
      try {
        await this.writer.write(encoded);
      } catch (cause) {
        throw new PluginProtocolError(
          this.plugin,
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
              code:
                error instanceof PluginRemoteError
                  ? error.code
                  : error instanceof z.ZodError
                    ? -32602
                    : -32603,
              ...(error instanceof PluginRemoteError && error.data !== undefined
                ? { data: error.data }
                : {}),
              message: error instanceof Error ? error.message : 'Plugin request failed',
            },
          };
        }
        await this.send(response);
      };
      // Requests must not block reading notifications or requests in the other direction.
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
    if ('error' in message) {
      pending.reject(
        new PluginRemoteError(message.error.code, message.error.message, message.error.data)
      );
      return;
    }
    if (!pending.schema) {
      pending.resolve(message.result);
      return;
    }
    // Rejects only this request, like a caller-side parse would; the connection stays usable.
    const parsed = pending.schema.safeParse(message.result);
    if (parsed.success) pending.resolve(parsed.data);
    else pending.reject(this.invalidPayload(pending.schema, parsed.error));
  }
  private messageName(raw: unknown): string {
    if (raw === null || typeof raw !== 'object') return 'unknown';
    if (
      'method' in raw &&
      typeof raw.method === 'string' &&
      (this.requests.has(raw.method) || this.notifications.has(raw.method))
    )
      return raw.method;
    if ('id' in raw && (typeof raw.id === 'string' || typeof raw.id === 'number')) {
      const pending = this.pending.get(raw.id);
      if (pending) return `${pending.method} response`;
    }
    return 'unknown';
  }
  private handleLine(decoder: TextDecoder, line: Uint8Array): void {
    this.reading = { bytes: line.byteLength, message: 'unknown' };
    try {
      let text: string;
      try {
        text = decoder.decode(line);
      } catch (error) {
        throw this.error('invalid UTF-8', error);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        throw this.error('malformed JSON', error);
      }
      this.reading = { bytes: line.byteLength, message: this.messageName(raw) };
      this.dispatch(this.parse(rpcMessageSchema, raw));
    } finally {
      this.reading = undefined;
    }
  }
  private async read(): Promise<void> {
    let parts: Uint8Array[] = [];
    let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const readChunk = (value: Uint8Array): void => {
      let start = 0;
      for (let index = 0; index <= value.length; index++) {
        const newline = index < value.length && value[index] === 10;
        if (!newline && index < value.length) continue;
        const part = value.subarray(start, index);
        bytes += part.byteLength;
        if (bytes > PLUGIN_MAX_MESSAGE_BYTES)
          throw new PluginProtocolError(
            this.plugin,
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
          this.handleLine(decoder, line);
          parts = [];
          bytes = 0;
        }
        start = index + 1;
      }
    };
    try {
      while (!this.ended) {
        const { value, done } = await this.reader.read();
        if (done) break;
        readChunk(value);
      }
      if (bytes) throw new PluginProtocolError(this.plugin, this.line + 1, 'unterminated message');
      if (this.failure) throw this.failure;
      if (this.pending.size)
        throw new PluginProtocolError(
          this.plugin,
          this.line,
          'connection ended with pending requests',
          undefined,
          'closed'
        );
      this.ended = true;
    } catch (cause) {
      const error =
        cause instanceof PluginProtocolError
          ? cause
          : new PluginProtocolError(
              this.plugin,
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
