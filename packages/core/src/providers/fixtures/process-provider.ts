import { closeSync, writeSync, existsSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { serveProvider } from '@archon/provider-contract/plugin';
import type { ProviderChunk, CredentialStatus, IAgentProvider } from '@archon/provider-contract';
import { descriptor, chunks } from './process-provider-data';

const mode = process.argv[2];
if (mode === 'mismatch') descriptor.version = '2';
if (mode === 'record-pid') writeFileSync(process.argv[3], String(process.pid));
async function closeOutput(): Promise<never> {
  writeFileSync(process.argv[3], String(process.pid));
  // On Windows closeSync(1) leaves the standard output handle open, so the host would
  // never see EOF; closing the handle itself does.
  if (process.platform === 'win32') {
    const ffi = await import('bun:ffi');
    const kernel32 = ffi.dlopen('kernel32.dll', {
      GetStdHandle: { args: [ffi.FFIType.i32], returns: ffi.FFIType.ptr },
      CloseHandle: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.bool },
    });
    const STD_OUTPUT_HANDLE = -11;
    kernel32.symbols.CloseHandle(kernel32.symbols.GetStdHandle(STD_OUTPUT_HANDLE));
  } else closeSync(1);
  setInterval(() => undefined, 1000);
  return await new Promise<never>(() => undefined);
}
await serveProvider(
  {
    descriptor,
    create: (log): IAgentProvider => ({
      getType: (): string => descriptor.id,
      getCapabilities: (): typeof descriptor.capabilities => descriptor.capabilities,
      async checkCredential({ env, signal }): Promise<CredentialStatus> {
        if (mode === 'live-eof') return await closeOutput();
        if (mode === 'credential-crash') {
          process.stderr.write(process.env.CUSTOM_CREDENTIAL ?? '');
          process.exit(7);
        }
        if (mode === 'hung-check')
          await new Promise<void>(resolve => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true }
            );
          });
        return env.TEST_CREDENTIAL
          ? { state: 'usable', source: 'native' }
          : { state: 'not_connected', source: 'native' };
      },
      async resolveCredentialModel(request): Promise<string> {
        if (mode === 'live-eof') return await closeOutput();
        return request.model ?? 'openai/native-model';
      },
      async *sendQuery(prompt, _cwd, resume, options): AsyncGenerator<ProviderChunk> {
        if (mode === 'live-eof') return await closeOutput();
        if (mode === 'resume') {
          yield { type: 'result', sessionId: resume };
          yield { type: 'settled' };
          return;
        }
        if (mode === 'slow-exit') {
          const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
          });
          grandchild.unref();
          writeFileSync(`${process.argv[3]}.pids`, JSON.stringify([process.pid, grandchild.pid]));
        }
        if (mode === 'mismatch') writeFileSync(process.argv[3], 'session started');
        if (mode === 'tree') {
          const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
          });
          writeFileSync(process.argv[3], JSON.stringify([process.pid, grandchild.pid]));
          options?.abortSignal?.addEventListener(
            'abort',
            () => {
              writeFileSync(`${process.argv[3]}.cancelled`, 'cancel received');
            },
            { once: true }
          );
          yield { type: 'state_update', state: 'running' };
          await new Promise<void>(() => undefined);
        }
        if (mode === 'crash') {
          yield { type: 'state_update', state: 'running' };
          process.stderr.write(`${prompt.split('\n')[0]}\n${process.env.REQUEST_AUTH ?? ''}\n`);
          const secret = process.env.TEST_CREDENTIAL ?? '';
          process.stderr.write(secret.slice(0, 6));
          await Bun.sleep(30);
          process.stderr.write(`${secret.slice(6)} crash evidence\n`);
          process.exit(7);
        }
        if (mode === 'logs') {
          await log({
            level: 'info',
            msg: `provider.ready ${options?.env?.CONTAINER_TOKEN ?? ''}`,
            bindings: {
              token: options?.env?.CONTAINER_TOKEN ?? '',
              hostToken: process.env.CONTAINER_TOKEN ?? '',
              custom: options?.env?.CUSTOM_AUTH ?? '',
              nested: { message: prompt, lines: prompt.split('\n'), count: 1 },
            },
          });
        }
        if (mode === 'plugin-env') {
          yield {
            type: 'result',
            text: JSON.stringify({
              host: process.env.PROCESS_HOST_CANARY,
              path: process.env.PATH,
              container: process.env.PROCESS_CANARY,
            }),
          };
          yield { type: 'settled' };
          return;
        }
        if (mode === 'env') {
          yield { type: 'result', text: JSON.stringify(options?.env) };
          yield { type: 'settled' };
          return;
        }
        if (prompt === 'failure') {
          yield { type: 'result', isError: true, failure: { class: 'auth', evidence: 'HTTP 401' } };
          yield { type: 'settled' };
          return;
        }
        if (mode === 'background') writeFileSync(process.argv[3], 'running');
        for (const chunk of chunks) {
          if (chunk.type === 'subtask' && chunk.status === 'completed') {
            if (mode === 'background') {
              while (!existsSync(`${process.argv[3]}.ack`)) await Bun.sleep(5);
              writeFileSync(process.argv[3], 'completed');
            } else await Bun.sleep(50);
          }
          yield chunk;
        }
      },
    }),
  },
  mode === 'live-eof'
    ? {
        readable: Readable.toWeb(process.stdin),
        writable: new WritableStream<Uint8Array>({
          write(data): void {
            writeSync(1, data);
          },
        }),
      }
    : undefined
);
if (mode === 'slow-exit') {
  writeFileSync(process.argv[3], 'closing');
  await Bun.sleep(500);
}
