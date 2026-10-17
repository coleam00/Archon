import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import {
  handleMessage,
  type AttachedFile,
  type ConversationLockManager,
  type HandleMessageContext,
} from '@archon/core';
import { getArchonHome, isPathInside } from '@archon/paths';
import type { WebAdapter } from '../adapters/web';
import { getLog } from './api-route-kit';

// Shared lock/dispatch/error handling for message and workflow endpoints
/** Maximum allowed upload size per file (10 MB) */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Maximum number of files per message (enforced server-side) */
const MAX_FILES_PER_MESSAGE = 5;
/**
 * Binary (non-text) MIME types explicitly allowed for upload.
 * All text/* types are accepted separately via isAllowedUploadType().
 */
const ALLOWED_UPLOAD_BINARY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  // application/json is a structured text type browsers may report for .json files
  'application/json',
]);

/** Extensions accepted when browser reports an empty MIME type (code/config files). */
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.log',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.rs',
  '.swift',
  '.kt',
  '.scala',
  '.r',
  '.sql',
]);

/** Returns true if the MIME type is allowed for upload. */
function isAllowedUploadType(mimeType: string, fileName: string): boolean {
  // All text/* types are acceptable (covers .md, .py, .rs, .go, .sh, .yaml, etc.)
  if (mimeType.startsWith('text/')) return true;
  if (ALLOWED_UPLOAD_BINARY_MIME_TYPES.has(mimeType)) return true;
  // Browsers assign empty MIME types to many code/config extensions — fall back to extension
  if (!mimeType) {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex !== -1) {
      return ALLOWED_UPLOAD_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase());
    }
  }
  return false;
}

export async function persistUploadedFiles(
  conversationId: string,
  fileEntries: File[]
): Promise<
  { ok: true; savedFiles: AttachedFile[] } | { ok: false; status: 400 | 500; error: string }
> {
  if (fileEntries.length > MAX_FILES_PER_MESSAGE) {
    return {
      ok: false,
      status: 400,
      error: `Maximum ${MAX_FILES_PER_MESSAGE.toString()} files per message`,
    };
  }

  const archonHome = getArchonHome();
  const uploadDir = join(archonHome, 'artifacts', 'uploads', conversationId);
  if (!isPathInside(archonHome, uploadDir, { lexical: true })) {
    return { ok: false, status: 400, error: 'Invalid conversation ID' };
  }

  // Validate all files before writing any to disk.
  for (const entry of fileEntries) {
    const displayName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!isAllowedUploadType(entry.type, entry.name)) {
      return {
        ok: false,
        status: 400,
        error: `File "${displayName}" has an unsupported type: ${entry.type}`,
      };
    }
    if (entry.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `File "${displayName}" exceeds the 10 MB size limit`,
      };
    }
  }

  const savedFiles: AttachedFile[] = [];
  try {
    await mkdir(uploadDir, { recursive: true });
    for (const entry of fileEntries) {
      const fileId = randomUUID();
      const safeName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = join(uploadDir, `${fileId}_${safeName}`);
      await writeFile(filePath, Buffer.from(await entry.arrayBuffer()));
      const normalizedMime =
        entry.type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
      savedFiles.push({
        path: filePath,
        name: safeName || fileId,
        mimeType: normalizedMime,
        size: entry.size,
      });
    }
  } catch (writeErr: unknown) {
    for (const f of savedFiles) {
      await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, filePath: f.path, conversationId }, 'upload.rollback_failed');
        }
      });
    }
    getLog().error({ err: writeErr, conversationId }, 'upload.write_failed');
    return {
      ok: false,
      status: 500,
      error: 'Failed to save uploaded file. Check available disk space.',
    };
  }

  return { ok: true, savedFiles };
}

export function createOrchestratorDispatch(
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager
) {
  return async function dispatchToOrchestrator(
    conversationId: string,
    message: string,
    extraContext: Omit<HandleMessageContext, 'isolationHints'>,
    filesToCleanup?: AttachedFile[]
  ): Promise<{ accepted: boolean; status: string }> {
    const result = await lockManager.acquireLock(conversationId, async () => {
      // Emit lock:true at handler start so the UI knows processing has begun.
      // Fire-and-forget — if no SSE stream is connected yet, the event is buffered.
      webAdapter.emitLockEvent(conversationId, true);
      try {
        await handleMessage(webAdapter, conversationId, message, {
          isolationHints: { workflowType: 'thread', workflowId: conversationId },
          ...extraContext,
        });
      } catch (error) {
        getLog().error({ err: error, conversationId }, 'handle_message_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'error',
              message: `Failed to process message: ${(error as Error).message ?? 'unknown error'}. Try /reset if the problem persists.`,
              classification: 'transient',
              timestamp: Date.now(),
            })
          );
        } catch (sseError) {
          getLog().error({ err: sseError, conversationId }, 'sse_error_emit_failed');
        }
      } finally {
        await webAdapter.emitLockEvent(conversationId, false);
        // Clean up uploaded files AFTER handleMessage completes so the AI subprocess
        // has had a chance to read them. Doing this in the HTTP handler's finally block
        // would delete files while the fire-and-forget lock handler is still running.
        // The directory is shared with uploads that have not written their first file yet.
        if (filesToCleanup) {
          for (const f of filesToCleanup) {
            await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn({ err, filePath: f.path, conversationId }, 'upload.cleanup_failed');
              }
            });
          }
        }
      }
    });

    if (result.status === 'queued-conversation' || result.status === 'queued-capacity') {
      // Intentionally fire-and-forget: the lock-acquire signal (locked: true) is sent
      // optimistically so the UI shows a queued state immediately. It is not awaited
      // because we want the HTTP response to return before the SSE write completes.
      // The lock-release signal (locked: false) IS awaited inside the task callback
      // above to guarantee ordering — all tool results and flush must precede the
      // release event on the SSE stream.
      webAdapter.emitLockEvent(conversationId, true);
    }

    return { accepted: true, status: result.status };
  };
}

export type OrchestratorDispatch = ReturnType<typeof createOrchestratorDispatch>;
