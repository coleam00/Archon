import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { serveProvider } from '@archon/provider-contract/plugin';
import type { ProviderChunk, CredentialStatus, IAgentProvider } from '@archon/provider-contract';
import { descriptor, chunks } from './process-provider-data';

const mode = process.argv[2];
if (mode === 'mismatch') descriptor.version = '2';
if (mode === 'record-pid') writeFileSync(process.argv[3], String(process.pid));
await serveProvider({
  descriptor,
  create: (): IAgentProvider => ({
    getType: (): string => descriptor.id,
    getCapabilities: (): typeof descriptor.capabilities => descriptor.capabilities,
    async checkCredential({ env, signal }): Promise<CredentialStatus> {
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
      return request.model ?? 'openai/native-model';
    },
    async *sendQuery(prompt, _cwd, _resume, options): AsyncGenerator<ProviderChunk> {
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
        const secret = process.env.TEST_CREDENTIAL ?? '';
        process.stderr.write(secret.slice(0, 6));
        await Bun.sleep(30);
        process.stderr.write(`${secret.slice(6)} crash evidence\n`);
        process.exit(7);
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
});
