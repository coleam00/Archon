import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChatPluginDescriptor } from '@archon/chat-contract/descriptor';
import { validateCommand } from '@archon/paths/plugin-process';

const descriptor: ChatPluginDescriptor = {
  protocol: 'archon-chat/1',
  id: 'fixture',
  displayName: 'Fixture',
  version: '1',
  capabilities: { defaultWorkflowDispatch: 'background' },
  policy: { workspaceRetention: 'retain' },
};
const sentinel = 'secret-message-and-token';
let mode = 'valid';
let child: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough };
let stopped = false;
let closing: Promise<void>;
let beginClose: () => void = () => undefined;
const nativeSetTimeout = setTimeout;
const command = process.platform === 'win32' ? 'C:\\fixture.exe' : '/fixture';
mock.module('node:child_process', () => ({
  spawn(
    _executable: string,
    _args: string[],
    options: { stdio: string[]; detached: boolean; windowsHide: boolean }
  ) {
    expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(options.detached).toBe(process.platform !== 'win32');
    expect(options.windowsHide).toBe(true);
    if (mode === 'spawn-throw') throw new Error(sentinel);
    stopped = false;
    closing = new Promise(resolve => {
      beginClose = resolve;
    });
    child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    child.stdin.on('data', data => {
      const request = JSON.parse(String(data));
      expect(request.method).toBe('initialize');
      if (mode === 'timeout' || mode === 'close-timeout') return;
      if (mode === 'eof') {
        child.stdout.end();
        return;
      }
      if (mode === 'spawn-error') {
        child.emit('error', new Error(sentinel));
        return;
      }
      if (mode === 'stdin-error') {
        child.stdin.emit('error', new Error(sentinel));
        return;
      }
      const reply =
        mode === 'remote-error'
          ? { error: { code: -32000, message: sentinel, data: sentinel } }
          : { result: mode === 'invalid' ? { ...descriptor, protocol: sentinel } : descriptor };
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }) + '\n');
    });
    if (mode === 'close-timeout') {
      child.stdin.end = (() => {
        beginClose();
        return child.stdin;
      }) as typeof child.stdin.end;
      // Complete initialize, then keep writer.close pending until the install deadline.
      child.stdin.removeAllListeners('data');
      child.stdin.on('data', data => {
        const request = JSON.parse(String(data));
        child.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result: descriptor }) + '\n'
        );
      });
    }
    return child;
  },
}));
mock.module('@archon/paths/plugin-process', () => ({
  validateCommand,
  async terminateTree(pid: number) {
    expect(pid).toBe(42);
    if (mode === 'cleanup-error') throw new Error(sentinel);
    stopped = true;
    child.emit('close');
  },
}));
const { inspectChatPlugin } = await import('./inspect-chat-plugin');
afterEach(() => {
  mock.restore();
});

test('inspection returns a validated descriptor only after child cleanup', async () => {
  mode = 'valid';
  expect(await inspectChatPlugin(command)).toEqual(descriptor);
  expect(stopped).toBe(true);
  expect(child.stdin.destroyed).toBe(true);
  expect(child.stdout.destroyed).toBe(true);
});

for (const failure of [
  'invalid',
  'remote-error',
  'eof',
  'spawn-throw',
  'spawn-error',
  'stdin-error',
  'cleanup-error',
  'timeout',
  'close-timeout',
]) {
  test(`inspection fails safely on ${failure}`, async () => {
    mode = failure;
    let callback: (() => void) | undefined;
    if (failure.includes('timeout')) {
      spyOn(globalThis, 'setTimeout').mockImplementation(
        Object.assign(
          (fn: Parameters<typeof setTimeout>[0]) => {
            callback = () => {
              if (typeof fn === 'function') fn();
            };
            return nativeSetTimeout(() => {}, 60_000);
          },
          { __promisify__: nativeSetTimeout.__promisify__ }
        )
      );
    }
    const inspection = inspectChatPlugin(command);
    if (callback) {
      if (failure === 'close-timeout') await closing;
      callback();
    }
    const error = await inspection.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sentinel);
    expect(String(error)).toContain(
      failure === 'cleanup-error' ? 'process cleanup failed' : 'failed initialize'
    );
    if (failure !== 'spawn-throw') {
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      if (failure !== 'cleanup-error') expect(stopped).toBe(true);
    }
  });
}
