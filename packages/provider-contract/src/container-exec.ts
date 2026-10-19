import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ContainerExecGate {
  run<T>(operation: () => Promise<T>): Promise<T>;
  failAdmission(error: Error): void;
}

// Container ids are process-local runtime handles, not persisted provider options.
// The backend registers the same gate used by transfers and lifecycle operations.
const gates = new Map<string, ContainerExecGate>();

export function registerContainerExecGate(
  containerId: string,
  gate: ContainerExecGate
): () => void {
  gates.set(containerId, gate);
  return () => {
    if (gates.get(containerId) === gate) gates.delete(containerId);
  };
}

const scope = new AsyncLocalStorage<{ containerId: string; gate: ContainerExecGate }>();

export function withContainerExecGate<T>(
  containerId: string,
  gate: ContainerExecGate,
  invoke: () => T
): T {
  return scope.run({ containerId, gate }, invoke);
}

export function getContainerExecGate(containerId: string): ContainerExecGate | undefined {
  const current = scope.getStore();
  return current?.containerId === containerId ? current.gate : gates.get(containerId);
}

export function coordinateContainerCommand<T>(
  containerId: string,
  operation: () => Promise<T>
): Promise<T> {
  const gate = getContainerExecGate(containerId);
  return gate ? gate.run(operation) : operation();
}

export interface ContainerExecCommand {
  prefix: readonly string[];
  command: readonly string[];
}

/**
 * Release admission only after the shell is running INSIDE the producer. A local
 * spawn event says nothing about whether Docker has admitted the exec yet.
 * The command body can then overlap transfers and other admitted command bodies.
 */

export async function admitContainerCommand<T>(
  containerId: string,
  args: ContainerExecCommand | ((marker: string) => string[]),
  start: (
    args: string[],
    observe: ((child: ChildProcess | undefined) => void) | undefined,
    clean: (stderr: string) => string
  ) => Promise<T>,
  forwardStderr?: (chunk: Buffer) => void
): Promise<T> {
  const gate = getContainerExecGate(containerId);
  if (!gate)
    return start(
      typeof args === 'function' ? args('') : [...args.prefix, ...args.command],
      undefined,
      value => value
    );
  let result: Promise<T> | undefined;
  await gate.run(async () => {
    const marker = Buffer.from(`archon-exec-${randomUUID()}\n`);
    const wrapped =
      typeof args === 'function'
        ? args(marker.toString())
        : [
            ...args.prefix,
            'sh',
            '-c',
            `printf '${marker.toString()}' >&2; exec "$@"`,
            'archon-exec',
            ...args.command,
          ];
    let acknowledged = false;
    let release!: () => void;
    const admitted = new Promise<void>(resolve => {
      release = resolve;
    });
    result = start(
      wrapped,
      child => {
        if (!child) {
          acknowledged = true;
          release();
          return;
        }
        let pending = Buffer.alloc(0);
        let seen = false;
        child.stderr?.on('data', (data: Buffer | string) => {
          const chunk = typeof data === 'string' ? Buffer.from(data) : data;
          if (seen) {
            forwardStderr?.(chunk);
            return;
          }
          pending = Buffer.concat([pending, chunk]);
          const offset = pending.indexOf(marker);
          if (offset >= 0) {
            seen = true;
            acknowledged = true;
            forwardStderr?.(
              Buffer.concat([pending.subarray(0, offset), pending.subarray(offset + marker.length)])
            );
            pending = Buffer.alloc(0);
            release();
          } else if (pending.length >= marker.length) {
            const end = pending.length - marker.length + 1;
            forwardStderr?.(pending.subarray(0, end));
            pending = pending.subarray(end);
          }
        });
        child.once('close', () => {
          if (pending.length) forwardStderr?.(pending);
        });
      },
      stderr => stderr.replace(marker.toString(), '')
    );
    // A failed start or a short command may settle without the acknowledgement.
    // Observe rejection immediately, even while the gate is waiting for admission.
    const settled = (): void => {
      if (!acknowledged) {
        gate.failAdmission(
          new Error(
            `Container '${containerId}' exec ended without an admission acknowledgement; inspect before explicit recovery`
          )
        );
      }
      release();
    };
    void result.then(settled, settled);
    await admitted;
  });
  if (!result) throw new Error('Container exec admission did not start a command');
  return result;
}
