/**
 * Shared attachment-download pipeline for chat adapters.
 *
 * Slack, Telegram, and Discord each receive inbound file attachments in a
 * platform-specific shape, but once reduced to "a URL, a name, an optional
 * declared size" the download/validate/save mechanics are identical — and
 * the safety properties (size caps, count caps, a fetch deadline, path
 * sanitization, an empty-directory cleanup) need to hold on every adapter
 * equally. This module is that one shared implementation (Rule of Three:
 * three adapters need it at once), consolidating what would otherwise be
 * three near-duplicate, independently-drifting copies.
 *
 * Mirrors the Web upload endpoint's caps (packages/server/src/routes/api.ts)
 * so the same file is subject to the same limits regardless of how it
 * arrived.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getArchonHome, createLogger } from '@archon/paths';
import type { AttachedFile } from '@archon/core';

const log = createLogger('adapters.attachment-download');

/** Mirrors the Web upload endpoint's per-file size cap. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Mirrors the Web upload endpoint's per-message file count cap. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/**
 * Per-attachment download deadline. Chat-platform file CDNs give no response
 * time guarantee and `fetch` has no default timeout, so a stalled connection
 * would otherwise hang the triggering message forever.
 */
export const DEFAULT_ATTACHMENT_TIMEOUT_MS = 30_000;

/**
 * One inbound file, reduced to what the download pipeline needs. Adapters
 * map their platform-specific event shape into this before calling
 * `downloadAttachments()`.
 */
export interface DownloadableAttachment {
  /** Ready-to-fetch URL. Must already be resolved (e.g. Telegram's getFile() round-trip happens before this). */
  url: string;
  /** Sent as the `Authorization` header value, if the platform requires one (e.g. `Bearer <token>`). */
  authorization?: string;
  /** Display name; sanitized before use as part of the on-disk filename. */
  name: string;
  /** Platform-side file id; sanitized before use as part of the on-disk filename. */
  id: string;
  mimeType?: string;
  /** Declared size from the source platform, if known — enables a pre-download size check. */
  size?: number;
}

export type SkippedAttachmentReason =
  | 'too_many'
  | 'too_large'
  | 'untrusted_url'
  | 'download_failed'
  | 'timeout';

export interface SkippedAttachment {
  name: string;
  reason: SkippedAttachmentReason;
}

export interface AttachmentDownloadOptions {
  /** Adapter name, used only for the upload-directory prefix and log context (e.g. 'telegram'). */
  platform: string;
  conversationId: string;
  /**
   * Proves a candidate's `url` actually points at the platform's own file
   * host before any `authorization` header is attached to the request —
   * required whenever a URL is sourced from inbound event data rather than a
   * fixed, Archon-owned constant.
   */
  isTrustedUrl: (url: string) => boolean;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface AttachmentDownloadResult {
  files: AttachedFile[];
  /** Empty string when nothing was downloaded — no directory was created. */
  uploadDir: string;
  skipped: SkippedAttachment[];
}

/**
 * Download, validate, and save inbound chat attachments to disk as
 * `AttachedFile[]` — the same shape the Web upload endpoint produces, so
 * every downstream consumer (the AI prompt, `ARCHON_ATTACHMENTS`) treats an
 * adapter-downloaded file identically to a web-uploaded one.
 *
 * Best-effort per file: one oversized, untrusted, or failed download never
 * fails the whole message — it's recorded in `skipped` for the caller to
 * relay back to the user (a silently missing file is exactly the failure
 * this feature exists to remove).
 */
export async function downloadAttachments(
  candidates: readonly DownloadableAttachment[],
  options: AttachmentDownloadOptions
): Promise<AttachmentDownloadResult> {
  if (candidates.length === 0) {
    return { files: [], uploadDir: '', skipped: [] };
  }

  const maxFiles = options.maxFiles ?? MAX_ATTACHMENTS_PER_MESSAGE;
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
  const { platform, conversationId, isTrustedUrl } = options;

  const skipped: SkippedAttachment[] = [];
  const toDownload = candidates.slice(0, maxFiles);
  if (candidates.length > maxFiles) {
    log.warn(
      { platform, conversationId, fileCount: candidates.length, limit: maxFiles },
      'attachment.count_truncated'
    );
    for (const dropped of candidates.slice(maxFiles)) {
      skipped.push({ name: dropped.name, reason: 'too_many' });
    }
  }

  // conversationId can carry characters invalid in directory names on some
  // platforms (Slack's is "channel:ts"). The random suffix makes the
  // directory unique PER CALL, not per conversation: every message in a
  // thread shares one conversation id, downloads run outside any per-
  // conversation lock, and the caller deletes this directory after use — a
  // shared directory would let one message's cleanup delete a concurrently
  // arriving sibling's still-unread attachments.
  const safeConversationId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const uploadDir = join(
    getArchonHome(),
    'artifacts',
    'uploads',
    `${platform}-${safeConversationId}-${randomUUID()}`
  );

  const saved: AttachedFile[] = [];
  let dirCreated = false;

  for (const file of toDownload) {
    if (!isTrustedUrl(file.url)) {
      log.warn({ platform, conversationId, name: file.name }, 'attachment.untrusted_url');
      skipped.push({ name: file.name, reason: 'untrusted_url' });
      continue;
    }
    if (file.size !== undefined && file.size > maxBytes) {
      log.warn(
        { platform, conversationId, name: file.name, size: file.size },
        'attachment.too_large'
      );
      skipped.push({ name: file.name, reason: 'too_large' });
      continue;
    }

    // Held across the body read as well as the request: a response that
    // starts and then stalls mid-body must abort too, not hang forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(file.url, {
        headers: file.authorization ? { Authorization: file.authorization } : undefined,
        signal: controller.signal,
        // A redirect target is unverified — never let an auth header silently
        // follow one. `response.ok` is false for a manual redirect status, so
        // this falls through to the ordinary download-failed path below.
        redirect: 'manual',
      });
      if (!response.ok) {
        log.warn(
          { platform, conversationId, name: file.name, status: response.status },
          'attachment.download_failed'
        );
        skipped.push({ name: file.name, reason: 'download_failed' });
        continue;
      }

      // Reject oversized files BEFORE buffering them. Declared size is
      // optional/unreliable on some platforms, so without this an attachment
      // of any size gets pulled fully into memory just to be discarded —
      // defeating the cap as a memory guard. The post-read check below is a
      // backstop for a missing or understated Content-Length.
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        log.warn(
          { platform, conversationId, name: file.name, size: declaredLength },
          'attachment.too_large'
        );
        skipped.push({ name: file.name, reason: 'too_large' });
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        log.warn(
          { platform, conversationId, name: file.name, size: buffer.byteLength },
          'attachment.too_large'
        );
        skipped.push({ name: file.name, reason: 'too_large' });
        continue;
      }

      await mkdir(uploadDir, { recursive: true });
      dirCreated = true;
      // Both path components are untrusted (sourced from inbound event
      // data). `basename` drops any directory part, then the character
      // class leaves nothing that can traverse — the id is stripped of dots
      // too, so a `..` segment can never form even if a platform id ever
      // contained one. Without this, an id or name carrying separators
      // could let writeFile escape uploadDir entirely.
      const safeName = basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeId = file.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = join(uploadDir, `${safeId}_${safeName}`);
      await writeFile(filePath, buffer);
      saved.push({
        path: filePath,
        name: safeName || safeId,
        mimeType: file.mimeType ?? 'application/octet-stream',
        size: buffer.byteLength,
      });
    } catch (error) {
      // An abort here is our own deadline firing, not a platform fault — log
      // it distinctly so a slow CDN isn't mistaken for a broken attachment.
      const timedOut = (error as Error).name === 'AbortError';
      log.warn(
        {
          err: error as Error,
          platform,
          conversationId,
          name: file.name,
          ...(timedOut ? { timeoutMs } : {}),
        },
        timedOut ? 'attachment.download_timeout' : 'attachment.download_error'
      );
      skipped.push({ name: file.name, reason: timedOut ? 'timeout' : 'download_failed' });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (dirCreated && saved.length === 0) {
    // mkdir ran but every write after it failed (disk error, etc.) — the
    // directory is empty, so remove it rather than leaving it orphaned. This
    // is the ONLY cleanup for that case: callers only run their own cleanup
    // when `files` comes back non-empty, so an empty result here would
    // otherwise never get swept.
    await rm(uploadDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn({ err, uploadDir, platform, conversationId }, 'attachment.empty_dir_cleanup_failed');
    });
  }

  log.info(
    {
      platform,
      conversationId,
      requested: candidates.length,
      saved: saved.length,
      skipped: skipped.length,
    },
    'attachment.download_completed'
  );
  return { files: saved, uploadDir, skipped };
}

/** Best-effort recursive cleanup of a download directory produced by `downloadAttachments()`. */
export async function cleanupAttachments(uploadDir: string): Promise<void> {
  if (!uploadDir) return;
  await rm(uploadDir, { recursive: true, force: true }).catch((err: unknown) => {
    log.warn({ err, uploadDir }, 'attachment.cleanup_failed');
  });
}

/**
 * Formats a user-facing, in-thread notice for any attachments that didn't
 * make it through. Returns `null` when there's nothing to report — callers
 * should treat that as "don't send a message."
 */
export function formatSkippedAttachmentsNotice(
  skipped: readonly SkippedAttachment[]
): string | null {
  if (skipped.length === 0) return null;
  const reasonText: Record<SkippedAttachmentReason, string> = {
    too_many: `more than ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files attached`,
    too_large: `exceeds the ${String(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB size limit`,
    untrusted_url: 'file link could not be verified',
    download_failed: 'download failed',
    timeout: 'download timed out',
  };
  const lines = skipped.map(s => `- ${s.name}: ${reasonText[s.reason]}`);
  const plural = skipped.length === 1 ? 'attachment' : 'attachments';
  return `⚠️ ${String(skipped.length)} ${plural} could not be processed:\n${lines.join('\n')}`;
}
