import {
  getContainerExecGate,
  withContainerExecGate,
  type ContainerExecGate,
} from '../container-exec';
import type { PluginRpc } from './rpc';
import {
  containerExecAcquireSchema,
  containerExecLeaseSchema,
  containerExecReleaseSchema,
} from './wire';

/** Bridge the runtime gate over the existing provider RPC connection. */
export function installContainerExecHost(rpc: PluginRpc): {
  enable(sessionId: string, gate: ContainerExecGate): void;
  end(sessionId: string): void;
} {
  interface Lease {
    active: boolean;
    release(): void;
    reject(error: Error): void;
  }
  const sessions = new Map<string, { gate: ContainerExecGate; leases: Map<string, Lease> }>();
  let nextLease = 0;
  const end = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    for (const lease of session.leases.values()) {
      const error = new Error(
        'Provider disconnected with an unfinished container exec operation; inspect before explicit recovery'
      );
      // A queued operation may be the signal for an already-running body.
      // Losing the provider loses that control even before the lease is granted.
      session.gate.failAdmission(error);
      lease.reject(error);
      lease.release();
    }
    session.leases.clear();
  };
  void rpc.done.then(
    () => {
      for (const id of sessions.keys()) end(id);
    },
    () => {
      for (const id of sessions.keys()) end(id);
    }
  );
  rpc.handle('_archon/container_exec/acquire', raw => {
    const { sessionId } = rpc.parse(containerExecAcquireSchema, raw);
    const session = sessions.get(sessionId);
    if (!session) throw rpc.error('container exec names an inactive or uncoordinated session');
    const leaseId = String(nextLease++);
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    return new Promise<{ leaseId: string }>((resolve, reject) => {
      const lease: Lease = { active: false, release, reject };
      session.leases.set(leaseId, lease);
      void session.gate
        .run(async () => {
          if (!session.leases.has(leaseId)) return;
          lease.active = true;
          resolve({ leaseId });
          await released;
        })
        .catch(reject)
        .finally(() => session.leases.delete(leaseId));
    });
  });
  rpc.handle('_archon/container_exec/release', raw => {
    const { sessionId, leaseId, failedAdmission } = rpc.parse(containerExecReleaseSchema, raw);
    const session = sessions.get(sessionId);
    const lease = session?.leases.get(leaseId);
    if (!session || !lease?.active) throw rpc.error('container exec names an unknown lease');
    if (failedAdmission)
      session.gate.failAdmission(
        new Error(
          'Provider exec ended without an admission acknowledgement; inspect before explicit recovery'
        )
      );
    session.leases.delete(leaseId);
    lease.release();
    return {};
  });
  return {
    enable: (sessionId, gate) => {
      sessions.set(sessionId, { gate, leases: new Map() });
    },
    end,
  };
}

export function withRemoteContainerExecGate<T>(
  rpc: PluginRpc,
  sessionId: string,
  containerId: string,
  invoke: () => Promise<T>
): Promise<T> {
  let failedAdmission = false;
  const pending = new Set<Promise<unknown>>();
  return withContainerExecGate(
    containerId,
    {
      run(operation) {
        const result = (async () => {
          const { leaseId } = rpc.parse(
            containerExecLeaseSchema,
            await rpc.request('_archon/container_exec/acquire', { sessionId })
          );
          const release = () =>
            rpc.request('_archon/container_exec/release', {
              sessionId,
              leaseId,
              failedAdmission,
            });
          let value;
          try {
            value = await operation();
          } catch (operationError) {
            try {
              await release();
            } catch (releaseError) {
              throw new AggregateError(
                [operationError, releaseError],
                'Container operation and lease release failed'
              );
            }
            throw operationError;
          }
          await release();
          return value;
        })();
        pending.add(result);
        void result.then(
          () => pending.delete(result),
          () => pending.delete(result)
        );
        return result;
      },
      failAdmission: () => {
        failedAdmission = true;
      },
    },
    async () => {
      try {
        return await invoke();
      } finally {
        // SDK kill() is synchronous and can leave an asynchronous control operation
        // unwinding after its iterator ends. Keep the session alive through release.
        while (pending.size) await Promise.allSettled([...pending]);
      }
    }
  );
}

export { getContainerExecGate };
