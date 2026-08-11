import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock logger to suppress noisy output during tests (matches the pattern used
// by the Slack/Telegram/Discord adapter test files that share this bun test
// invocation — `getArchonHome` is intentionally left real, see below).
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
  createLogger: mock(() => mockLogger),
}));

import {
  downloadAttachments,
  cleanupAttachments,
  formatSkippedAttachmentsNotice,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type DownloadableAttachment,
} from './attachment-download';

/** `getArchonHome()` is not mocked above — the real implementation reads
 * `process.env.ARCHON_HOME` at call time (see packages/paths), so pointing it
 * at a fresh temp directory per test keeps every download call confined
 * there without touching a real user's `~/.archon`. */
let tempHome: string;
let originalArchonHome: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'attachment-download-test-'));
  originalArchonHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = tempHome;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalArchonHome === undefined) {
    delete process.env.ARCHON_HOME;
  } else {
    process.env.ARCHON_HOME = originalArchonHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const alwaysTrusted = (): boolean => true;

function mockFetchOnce(response: Partial<Response> & { body?: ArrayBuffer }): void {
  globalThis.fetch = mock(() =>
    Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      headers: response.headers ?? new Headers(),
      arrayBuffer: () => Promise.resolve(response.body ?? new ArrayBuffer(4)),
    } as Response)
  ) as unknown as typeof fetch;
}

describe('downloadAttachments', () => {
  test('returns empty result for no candidates', async () => {
    const result = await downloadAttachments([], {
      platform: 'test',
      conversationId: 'c1',
      isTrustedUrl: alwaysTrusted,
    });
    expect(result).toEqual({ files: [], uploadDir: '', skipped: [] });
  });

  test('downloads a file and produces an AttachedFile with a sanitized name', async () => {
    const body = new TextEncoder().encode('hello world').buffer;
    mockFetchOnce({ headers: new Headers({ 'content-length': String(body.byteLength) }), body });

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/f1', name: 'my file!.txt', id: 'F1', mimeType: 'text/plain' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    expect(result.skipped).toEqual([]);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.name).toBe('my_file_.txt');
    expect(file.mimeType).toBe('text/plain');
    expect(file.size).toBe(body.byteLength);
    expect(existsSync(file.path)).toBe(true);
    expect(result.uploadDir.startsWith(tempHome)).toBe(true);
  });

  test('an untrusted URL is skipped without ever calling fetch', async () => {
    const fetchSpy = mock(() => Promise.reject(new Error('should not be called')));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const candidates: DownloadableAttachment[] = [
      { url: 'https://evil.example.com/f1', name: 'f1.txt', id: 'F1' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: () => false,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'f1.txt', reason: 'untrusted_url' }]);
  });

  test('candidates beyond maxFiles are skipped as too_many, only the first maxFiles download', async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      } as Response);
    }) as unknown as typeof fetch;

    const candidates: DownloadableAttachment[] = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE + 2 },
      (_, i) => ({
        url: `https://example.com/f${String(i)}`,
        name: `f${String(i)}.txt`,
        id: `F${String(i)}`,
      })
    );
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    expect(fetchCalls).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(result.files).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(result.skipped).toEqual([
      { name: 'f5.txt', reason: 'too_many' },
      { name: 'f6.txt', reason: 'too_many' },
    ]);
  });

  test('a candidate with a declared size over the cap is skipped before any fetch', async () => {
    const fetchSpy = mock(() => Promise.reject(new Error('should not be called')));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/big', name: 'big.bin', id: 'F1', size: MAX_ATTACHMENT_BYTES + 1 },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ name: 'big.bin', reason: 'too_large' }]);
  });

  test('an over-cap Content-Length header rejects before buffering the body', async () => {
    const arrayBufferSpy = mock(() => Promise.resolve(new ArrayBuffer(4)));
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }),
        arrayBuffer: arrayBufferSpy,
      } as unknown as Response)
    ) as unknown as typeof fetch;

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/big', name: 'big.bin', id: 'F1' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ name: 'big.bin', reason: 'too_large' }]);
  });

  test('an over-cap actual body size is rejected as a backstop when Content-Length is missing', async () => {
    const oversized = new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1);
    mockFetchOnce({ headers: new Headers(), body: oversized });

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/big', name: 'big.bin', id: 'F1' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'big.bin', reason: 'too_large' }]);
  });

  test('a non-ok response is skipped as download_failed', async () => {
    mockFetchOnce({ ok: false, status: 403 });

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/f1', name: 'f1.txt', id: 'F1' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'f1.txt', reason: 'download_failed' }]);
  });

  test('an aborted fetch is reported as a timeout, not a generic failure', async () => {
    globalThis.fetch = mock(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/f1', name: 'f1.txt', id: 'F1' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
      timeoutMs: 5,
    });

    expect(result.skipped).toEqual([{ name: 'f1.txt', reason: 'timeout' }]);
  });

  test('an empty upload directory (every write failed) is cleaned up, not left orphaned', async () => {
    mockFetchOnce({ ok: false, status: 500 });

    const candidates: DownloadableAttachment[] = [
      { url: 'https://example.com/f1', name: 'f1.txt', id: 'F1' },
    ];
    const result = await downloadAttachments(candidates, {
      platform: 'test',
      conversationId: 'conv-1',
      isTrustedUrl: alwaysTrusted,
    });

    // Nothing was saved, so no directory should have been created at all —
    // and even if it had been, it must not survive.
    expect(result.files).toEqual([]);
    if (result.uploadDir) {
      expect(existsSync(result.uploadDir)).toBe(false);
    }
  });
});

describe('cleanupAttachments', () => {
  test('removes the directory produced by a successful download', async () => {
    const body = new TextEncoder().encode('data').buffer;
    mockFetchOnce({ headers: new Headers({ 'content-length': String(body.byteLength) }), body });

    const result = await downloadAttachments(
      [{ url: 'https://example.com/f1', name: 'f1.txt', id: 'F1' }],
      { platform: 'test', conversationId: 'conv-1', isTrustedUrl: alwaysTrusted }
    );
    expect(existsSync(result.uploadDir)).toBe(true);

    await cleanupAttachments(result.uploadDir);
    expect(existsSync(result.uploadDir)).toBe(false);
  });

  test('is a no-op for an empty string (nothing was ever downloaded)', async () => {
    await expect(cleanupAttachments('')).resolves.toBeUndefined();
  });
});

describe('formatSkippedAttachmentsNotice', () => {
  test('returns null when nothing was skipped', () => {
    expect(formatSkippedAttachmentsNotice([])).toBeNull();
  });

  test('formats a human-readable notice covering every skip reason', () => {
    const notice = formatSkippedAttachmentsNotice([
      { name: 'a.txt', reason: 'too_many' },
      { name: 'b.bin', reason: 'too_large' },
      { name: 'c.txt', reason: 'untrusted_url' },
      { name: 'd.txt', reason: 'download_failed' },
      { name: 'e.txt', reason: 'timeout' },
    ]);
    expect(notice).not.toBeNull();
    expect(notice).toContain('5 attachments');
    expect(notice).toContain('a.txt');
    expect(notice).toContain('e.txt');
  });

  test('uses singular phrasing for exactly one skipped attachment', () => {
    const notice = formatSkippedAttachmentsNotice([{ name: 'a.txt', reason: 'timeout' }]);
    expect(notice).toContain('1 attachment could not be processed');
    expect(notice).not.toContain('1 attachments');
  });
});
