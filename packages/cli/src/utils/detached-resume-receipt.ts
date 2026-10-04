import type { ChildProcess } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

export const DETACHED_RESUME_RECEIPT_ENV = 'ARCHON_DETACHED_RESUME_RECEIPT';
export const DETACHED_RESUME_RECEIPT_FD = 3;
export const DETACHED_RESUME_RECEIPT = 'archon-resume-accepted\n';
export const DETACHED_RESUME_CONFIRMATION_MS = 60_000;

export function waitForDetachedResumeReceipt(
  child: ChildProcess,
  pipe: Readable,
  exitError: (code: number | null, signal: NodeJS.Signals | null) => Error
): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
      pipe.off('data', onData);
      pipe.off('error', onError);
      pipe.destroy();
      child.unref();
    };
    const settle = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => {
      settle(error);
    };
    const onData = (chunk: Buffer | string): void => {
      received += chunk.toString();
      if (received === DETACHED_RESUME_RECEIPT) settle();
      else if (!DETACHED_RESUME_RECEIPT.startsWith(received)) {
        settle(new Error('Malformed detached resume acceptance receipt.'));
      }
    };
    // Child close follows stdio drainage and carries exit details even when pipe EOF
    // arrives before exit. A receipt already buffered at exit must still win.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(exitError(code, signal));
    };
    const timer = setTimeout(() => {
      settle(
        new Error(
          'Detached resume acceptance was not confirmed within 60 seconds. The child may still continue; inspect the run before retrying.'
        )
      );
    }, DETACHED_RESUME_CONFIRMATION_MS);
    child.once('error', onError);
    child.once('close', onClose);
    pipe.on('data', onData);
    pipe.once('error', onError);
  });
}

export function consumeDetachedResumeReceiptRequest(
  onError: (runId: string, error: unknown) => void
): ((runId: string) => void) | undefined {
  const requested = process.env[DETACHED_RESUME_RECEIPT_ENV] === '1';
  Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
  if (!requested) return undefined;
  let sent = false;
  return runId => {
    if (sent) return;
    sent = true;
    try {
      writeFileSync(DETACHED_RESUME_RECEIPT_FD, DETACHED_RESUME_RECEIPT);
    } catch (error) {
      // Admission already committed: losing the launcher must not stop execution.
      onError(runId, error);
    } finally {
      try {
        closeSync(DETACHED_RESUME_RECEIPT_FD);
      } catch (error) {
        onError(runId, error);
      }
    }
  };
}
