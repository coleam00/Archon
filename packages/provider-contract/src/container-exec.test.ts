import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  admitContainerCommand,
  coordinateContainerCommand,
  registerContainerExecGate,
  type ContainerExecGate,
} from './container-exec';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function queue(): ContainerExecGate {
  let tail: Promise<unknown> = Promise.resolve();
  let failure: Error | undefined;
  return {
    run(operation) {
      const next = tail
        .catch(() => undefined)
        .then(() => {
          if (failure) throw failure;
          return operation();
        });
      tail = next;
      return next;
    },
    failAdmission(error) {
      failure = error;
    },
  };
}

function childFixture() {
  return Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
  }) as unknown as ChildProcess;
}

function ack(args: string[]): string {
  const shell = args[args.indexOf('-c') + 1]!;
  return shell.slice(shell.indexOf("printf '") + 8, shell.indexOf("' >&2"));
}

describe('container exec admission', () => {
  test('waits for daemon admission, then permits transfers and overlapping bodies', async () => {
    const gate = queue();
    const unregister = registerContainerExecGate('admission', gate);
    const body = deferred<string>();
    const started = deferred();
    const child = childFixture();
    let marker = '';
    let transfer = false;
    let second = false;
    try {
      const first = admitContainerCommand(
        'admission',
        { prefix: ['exec', 'admission'], command: ['bash'] },
        (args, observe) => {
          marker = ack(args);
          observe?.(child);
          child.emit('spawn');
          started.resolve();
          return body.promise;
        }
      );
      await started.promise;
      const frozen = gate.run(async () => {
        transfer = true;
      });
      const peer = admitContainerCommand(
        'admission',
        { prefix: ['exec', 'admission'], command: ['bash'] },
        (args, observe) => {
          const peerChild = childFixture();
          observe?.(peerChild);
          peerChild.stderr?.emit('data', Buffer.from(ack(args)));
          second = true;
          return body.promise;
        }
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(transfer).toBe(false);
      expect(second).toBe(false);
      // Split the acknowledgement across stream chunks, as Docker may do.
      child.stderr?.emit('data', Buffer.from(marker.slice(0, 10)));
      expect(transfer).toBe(false);
      child.stderr?.emit('data', Buffer.from(marker.slice(10)));
      await frozen;
      expect(transfer).toBe(true);
      // Both bodies remain unfinished while a queued control command proceeds.
      await coordinateContainerCommand('admission', async () => {
        expect(second).toBe(true);
      });
      body.resolve('complete');
      expect(await Promise.all([first, peer])).toEqual(['complete', 'complete']);
    } finally {
      body.resolve('cleanup');
      unregister();
    }
  });

  test('starts neither exec nor control while a transfer holds the gate', async () => {
    const gate = queue();
    const unregister = registerContainerExecGate('frozen', gate);
    const release = deferred();
    const frozen = deferred();
    const transfer = gate.run(async () => {
      frozen.resolve();
      await release.promise;
    });
    await frozen.promise;
    let started = false;
    let controlled = false;
    const invocation = admitContainerCommand(
      'frozen',
      { prefix: ['exec', 'frozen'], command: ['true'] },
      async (_args, observe) => {
        started = true;
        observe?.(undefined);
      }
    );
    const control = coordinateContainerCommand('frozen', async () => {
      controlled = true;
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(started).toBe(false);
      expect(controlled).toBe(false);
      release.resolve();
      await Promise.all([transfer, invocation, control]);
      expect(started).toBe(true);
      expect(controlled).toBe(true);
    } finally {
      release.resolve();
      unregister();
    }
  });

  test('an unacknowledged failed exec blocks transfers and later commands', async () => {
    const gate = queue();
    const unregister = registerContainerExecGate('unknown', gate);
    try {
      await expect(
        admitContainerCommand(
          'unknown',
          { prefix: ['exec', 'unknown'], command: ['true'] },
          async () => {
            throw new Error('Docker client lost');
          }
        )
      ).rejects.toThrow('Docker client lost');
      await expect(gate.run(async () => {})).rejects.toThrow(
        'without an admission acknowledgement'
      );
      await expect(coordinateContainerCommand('unknown', async () => {})).rejects.toThrow(
        'inspect'
      );
    } finally {
      unregister();
    }
  });

  test.skipIf(process.platform === 'win32')(
    'the real shell wrapper preserves argv, stdin, and diagnostics',
    async () => {
      const gate = queue();
      const unregister = registerContainerExecGate('shell', gate);
      const diagnostics: Buffer[] = [];
      try {
        const result = await admitContainerCommand(
          'shell',
          {
            prefix: ['exec', 'shell'],
            command: ['sh', '-c', 'cat; printf "%s" "$1"; echo diagnostic >&2', 'body', 'a $ b'],
          },
          (args, observe) =>
            new Promise<string>((resolve, reject) => {
              const child = spawn('sh', args.slice(3));
              observe?.(child);
              let output = '';
              child.stdout.on('data', chunk => {
                output += String(chunk);
              });
              child.once('error', reject);
              child.once('close', code =>
                code === 0 ? resolve(output) : reject(new Error(String(code)))
              );
              child.stdin.end('payload\n');
            }),
          chunk => {
            diagnostics.push(chunk);
          }
        );
        expect(result).toBe('payload\na $ b');
        expect(Buffer.concat(diagnostics).toString()).toBe('diagnostic\n');
      } finally {
        unregister();
      }
    }
  );
});
