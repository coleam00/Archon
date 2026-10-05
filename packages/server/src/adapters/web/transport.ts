import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.transport');
  return cachedLog;
}

export const DASHBOARD_STREAM = '__dashboard__';

export interface SSEWriter {
  writeSSE(data: { data: string; event?: string; id?: string }): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
}

/** Grace period (ms) before firing onCleanup after stream removal. */
const RECONNECT_GRACE_MS = 5_000;

/**
 * Max time (ms) to hold buffered events waiting for a stream to connect.
 *
 * Must be ≥ RECONNECT_GRACE_MS — otherwise events emitted during a reconnect
 * window are dropped *before* the client has had a chance to reconnect, which
 * manifests as perpetually-spinning tool cards when a `tool_result` happens to
 * land in the gap. 60s covers typical EventSource auto-reconnect delays on
 * flaky networks (mobile, VPN, laptop sleep) without meaningfully growing
 * memory footprint — events are small JSON strings and the cap below bounds
 * the worst case.
 */
const EVENT_BUFFER_TTL_MS = 60_000;

/** Max events to buffer per conversation before oldest are dropped. */
const EVENT_BUFFER_MAX = 500;

/** Min interval (ms) between `transport.buffer_evicted_oldest` warns per conversation. */
const EVICTION_WARN_THROTTLE_MS = 5_000;

// Fail-fast invariant: buffer TTL must outlive the reconnect grace window,
// otherwise events emitted during a reconnect can be dropped before the
// client has had a chance to come back. See comment on EVENT_BUFFER_TTL_MS.
if (EVENT_BUFFER_TTL_MS < RECONNECT_GRACE_MS) {
  throw new Error(
    `EVENT_BUFFER_TTL_MS (${EVENT_BUFFER_TTL_MS}) must be >= RECONNECT_GRACE_MS (${RECONNECT_GRACE_MS})`
  );
}

interface BufferedEvent {
  data: string;
  timestamp: number;
}

export class SSETransport {
  private streams = new Map<string, Set<SSEWriter>>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private zombieReaperHandle: ReturnType<typeof setInterval> | null = null;
  private eventBuffer = new Map<string, BufferedEvent[]>();
  private bufferCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastEvictionWarnAt = new Map<string, number>();

  constructor(
    private onCleanup?: (conversationId: string) => void,
    private graceMs: number = RECONNECT_GRACE_MS
  ) {}

  /**
   * Dashboard connections coexist; a conversation reconnect replaces its old stream.
   * Replays any buffered events that arrived before the stream connected.
   */
  registerStream(conversationId: string, stream: SSEWriter): void {
    let streams = this.streams.get(conversationId);
    if (conversationId !== DASHBOARD_STREAM && streams) {
      for (const existing of streams) {
        if (!existing.closed) {
          existing.close().catch((e: unknown) => {
            getLog().warn({ conversationId, err: e }, 'sse_close_failed');
          });
        }
      }
      streams.clear();
    }
    if (!streams) {
      streams = new Set<SSEWriter>();
      this.streams.set(conversationId, streams);
    }
    streams.add(stream);

    // Cancel pending cleanup — client reconnected
    const pendingCleanup = this.cleanupTimers.get(conversationId);
    if (pendingCleanup) {
      clearTimeout(pendingCleanup);
      this.cleanupTimers.delete(conversationId);
    }

    // Replay buffered events that arrived before the stream connected
    const buffered = this.eventBuffer.get(conversationId);
    if (buffered && buffered.length > 0) {
      const now = Date.now();
      const valid = buffered.filter(e => now - e.timestamp < EVENT_BUFFER_TTL_MS);
      const expired = buffered.length - valid.length;
      this.clearBuffer(conversationId);
      if (expired > 0) {
        // Events outlived the buffer TTL before the client reconnected.
        // Symptom on the UI: stuck tool cards for any tool_result that was
        // in the expired batch. If this fires in practice, bump TTL further.
        getLog().warn(
          { conversationId, expired, ttlMs: EVENT_BUFFER_TTL_MS },
          'transport.buffer_ttl_expired'
        );
      }
      if (valid.length > 0) {
        getLog().debug({ conversationId, count: valid.length }, 'sse_buffer_replay');
        for (const event of valid) {
          if (stream.closed) break;
          void this.writeToStream(conversationId, stream, event.data);
        }
      }
    }
  }

  removeStream(conversationId: string, expectedStream?: SSEWriter): void {
    const streams = this.streams.get(conversationId);
    if (!streams) return;
    if (expectedStream) {
      if (!streams.delete(expectedStream)) return;
      if (streams.size > 0) return;
    }
    this.streams.delete(conversationId);
    this.scheduleCleanup(conversationId, this.graceMs);
  }

  hasActiveStream(conversationId: string): boolean {
    const streams = this.streams.get(conversationId);
    return streams !== undefined && [...streams].some(stream => !stream.closed);
  }

  start(): void {
    // Reap zombie streams every 5 minutes
    this.zombieReaperHandle = setInterval(() => {
      for (const [id, streams] of this.streams) {
        for (const stream of streams) {
          if (stream.closed) this.removeStream(id, stream);
        }
      }
    }, 300_000);

    getLog().info('web.adapter_ready');
  }

  stop(): void {
    // Stop zombie stream reaper
    if (this.zombieReaperHandle) {
      clearInterval(this.zombieReaperHandle);
      this.zombieReaperHandle = null;
    }

    for (const [id, streams] of this.streams) {
      for (const stream of streams) {
        if (!stream.closed) {
          stream.close().catch((e: unknown) => {
            getLog().warn({ conversationId: id, err: e }, 'sse_close_failed');
          });
        }
        getLog().debug({ conversationId: id }, 'sse_stream_closed');
      }
    }
    this.streams.clear();
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.eventBuffer.clear();
    this.lastEvictionWarnAt.clear();
    for (const timer of this.bufferCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.bufferCleanupTimers.clear();
    getLog().info('web.adapter_stopped');
  }

  async emit(conversationId: string, event: string): Promise<void> {
    const writes: Promise<void>[] = [];
    const streams = this.streams.get(conversationId);
    if (streams) {
      for (const stream of streams) {
        if (stream.closed) {
          this.removeStream(conversationId, stream);
        } else {
          writes.push(this.writeToStream(conversationId, stream, event));
        }
      }
    }
    if (writes.length === 0) {
      this.bufferEvent(conversationId, event);
    }
    await Promise.all(writes);
  }

  /** Emit a workflow event without waiting for connected writers. */
  emitWorkflowEvent(conversationId: string, event: string): void {
    void this.emit(conversationId, event);
  }

  private async writeToStream(
    conversationId: string,
    stream: SSEWriter,
    event: string
  ): Promise<void> {
    try {
      await stream.writeSSE({ data: event });
    } catch (e: unknown) {
      getLog().warn({ conversationId, err: e }, 'sse_write_failed');
      this.removeStream(conversationId, stream);
      // Closing lets EventSource reconnect; a late failure cannot remove its replacement.
      stream.close().catch((err: unknown) => {
        getLog().warn({ conversationId, err }, 'sse_close_failed');
      });
    }
  }

  /**
   * Buffer an event for later replay when a stream connects.
   * Events expire after EVENT_BUFFER_TTL_MS and are capped at EVENT_BUFFER_MAX per conversation.
   */
  private bufferEvent(conversationId: string, data: string): void {
    let buf = this.eventBuffer.get(conversationId);
    if (!buf) {
      buf = [];
      this.eventBuffer.set(conversationId, buf);
    }
    buf.push({ data, timestamp: Date.now() });
    // Cap buffer size — drop oldest if over limit. Warn so we notice if
    // this ever happens in practice: evicted events mean the UI will miss
    // something when the client reconnects.
    if (buf.length > EVENT_BUFFER_MAX) {
      buf.shift();
      // Throttle: a runaway producer could overflow by hundreds in a tight
      // loop and flood logs. Warn at most once per EVICTION_WARN_THROTTLE_MS
      // per conversation — enough to notice in practice without flooding.
      const lastWarn = this.lastEvictionWarnAt.get(conversationId) ?? 0;
      const now = Date.now();
      if (now - lastWarn >= EVICTION_WARN_THROTTLE_MS) {
        this.lastEvictionWarnAt.set(conversationId, now);
        getLog().warn(
          { conversationId, bufferMax: EVENT_BUFFER_MAX },
          'transport.buffer_evicted_oldest'
        );
      }
    }
    // Schedule auto-cleanup so buffers don't leak for conversations that never
    // connect. Reset the timer on each new event so the buffer is held for
    // TTL past the *most recent* event, not the first one.
    const existingCleanup = this.bufferCleanupTimers.get(conversationId);
    if (existingCleanup) clearTimeout(existingCleanup);
    const timer = setTimeout(() => {
      this.clearBuffer(conversationId);
    }, EVENT_BUFFER_TTL_MS + 500);
    this.bufferCleanupTimers.set(conversationId, timer);
    getLog().debug({ conversationId, buffered: buf.length }, 'sse_event_buffered');
  }

  private clearBuffer(conversationId: string): void {
    this.eventBuffer.delete(conversationId);
    this.lastEvictionWarnAt.delete(conversationId);
    const timer = this.bufferCleanupTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.bufferCleanupTimers.delete(conversationId);
    }
  }

  /**
   * Schedule onCleanup callback after a delay.
   * If the client reconnects before the timer fires, the cleanup is cancelled.
   */
  private scheduleCleanup(conversationId: string, delayMs: number): void {
    // Cancel any existing timer for this conversation
    const existing = this.cleanupTimers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      try {
        this.cleanupTimers.delete(conversationId);
        // Only clean up if stream is still absent (client didn't reconnect)
        if (!this.streams.has(conversationId)) {
          if (this.onCleanup) {
            this.onCleanup(conversationId);
          }
        }
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'cleanup_timer_failed');
      }
    }, delayMs);

    this.cleanupTimers.set(conversationId, timer);
  }
}
