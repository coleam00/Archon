import { afterEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { DETACHED_RUN_FAILED_EXIT_CODE } from './workflow-exit-code';
import {
  DETACHED_RESUME_CONFIRMATION_MS,
  DETACHED_RESUME_RECEIPT,
  DETACHED_RESUME_RECEIPT_ENV,
  consumeDetachedResumeReceiptRequest,
  waitForDetachedResumeReceipt,
} from './detached-resume-receipt';

afterEach(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
});

function fixture(): {
  child: ChildProcess;
  pipe: PassThrough;
  unref: ReturnType<typeof spyOn>;
  result: Promise<void>;
} {
  const child = new ChildProcess();
  const pipe = new PassThrough();
  const unref = spyOn(child, 'unref').mockImplementation(() => {});
  const result = waitForDetachedResumeReceipt(
    child,
    pipe,
    (code, signal) => new Error(`No receipt: exit ${String(code)}, signal ${String(signal)}`)
  );
  return { child, pipe, unref, result };
}

function expectReleased(f: ReturnType<typeof fixture>): void {
  expect(f.pipe.destroyed).toBe(true);
  expect(f.unref).toHaveBeenCalledTimes(1);
  expect(f.child.listenerCount('exit')).toBe(0);
  expect(f.child.listenerCount('error')).toBe(0);
  expect(f.child.listenerCount('close')).toBe(0);
  expect(f.pipe.listenerCount('data')).toBe(0);
  expect(f.pipe.listenerCount('error')).toBe(0);
  expect(f.pipe.listenerCount('end')).toBe(0);
  expect(f.pipe.listenerCount('close')).toBe(0);
}

describe('detached resume acceptance', () => {
  it('waits beyond the startup window, accepts fragmented bytes, and releases the child', async () => {
    jest.useFakeTimers();
    const f = fixture();
    let accepted = false;
    void f.result.then(() => {
      accepted = true;
    });
    jest.advanceTimersByTime(501);
    await Promise.resolve();
    expect(accepted).toBe(false);
    f.pipe.write(DETACHED_RESUME_RECEIPT.slice(0, 5));
    expect(accepted).toBe(false);
    f.pipe.write(DETACHED_RESUME_RECEIPT.slice(5));
    await f.result;
    expectReleased(f);
    jest.advanceTimersByTime(DETACHED_RESUME_CONFIRMATION_MS);
    expectReleased(f);
  });

  it('lets buffered acceptance win over process exit', async () => {
    const f = fixture();
    f.child.emit('exit', 0, null);
    f.pipe.write(DETACHED_RESUME_RECEIPT);
    f.child.emit('close', 0, null);
    await f.result;
    expectReleased(f);
  });

  for (const code of [0, 1, DETACHED_RUN_FAILED_EXIT_CODE]) {
    it(`refuses exit ${String(code)} without acceptance`, async () => {
      const f = fixture();
      f.child.emit('exit', code, null);
      f.child.emit('close', code, null);
      await expect(f.result).rejects.toThrow(`exit ${String(code)}`);
      expectReleased(f);
    });
  }

  for (const source of ['child', 'pipe'] as const) {
    it(`preserves ${source} errors`, async () => {
      const f = fixture();
      const error = new Error(`${source} failed`);
      f[source].emit('error', error);
      await expect(f.result).rejects.toBe(error);
      expectReleased(f);
    });
  }

  it('preserves the exit signal after drainage without a complete receipt', async () => {
    const f = fixture();
    f.pipe.write(DETACHED_RESUME_RECEIPT.slice(0, 5));
    f.child.emit('exit', null, 'SIGTERM');
    f.child.emit('close', null, 'SIGTERM');
    await expect(f.result).rejects.toThrow('signal SIGTERM');
    expectReleased(f);
  });

  it('refuses malformed receipt bytes', async () => {
    const f = fixture();
    f.pipe.write('no');
    await expect(f.result).rejects.toThrow('Malformed');
    expectReleased(f);
  });

  it('refuses pipe closure without acceptance', async () => {
    const f = fixture();
    f.pipe.emit('close');
    f.child.emit('close', null, null);
    await expect(f.result).rejects.toThrow('No receipt');
    expectReleased(f);
  });

  it('bounds confirmation without killing the child', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const kill = spyOn(f.child, 'kill');
    jest.advanceTimersByTime(DETACHED_RESUME_CONFIRMATION_MS);
    await expect(f.result).rejects.toThrow('inspect the run before retrying');
    expect(kill).not.toHaveBeenCalled();
    expectReleased(f);
  });

  it('consumes the marker and sends only once, even if delivery fails', () => {
    process.env[DETACHED_RESUME_RECEIPT_ENV] = '1';
    const error = Object.assign(new Error('closed pipe'), { code: 'EPIPE' });
    const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw error;
    });
    const close = spyOn(fs, 'closeSync').mockImplementation(() => {});
    const report = mock(() => {});
    try {
      const notify = consumeDetachedResumeReceiptRequest(report);
      expect(process.env[DETACHED_RESUME_RECEIPT_ENV]).toBeUndefined();
      expect(notify).toBeDefined();
      notify?.('run-1');
      notify?.('run-1');
      expect(write).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith('run-1', error);
    } finally {
      write.mockRestore();
      close.mockRestore();
    }
  });
});
