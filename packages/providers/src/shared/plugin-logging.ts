import { providerFailureSchema } from '@archon/provider-contract';
import { z } from 'zod';
import { setLogSink, setLogDestination } from '@archon/paths';
import type { ProviderLogSink, ProviderLog } from '@archon/provider-contract/plugin';

const recordSchema = z
  .object({
    level: z.number(),
    msg: z.string(),
    module: z.string().optional(),
  })
  .catchall(z.json());
const levels = new Map<number, ProviderLog['level']>([
  [10, 'trace'],
  [20, 'debug'],
  [30, 'info'],
  [40, 'warn'],
  [50, 'error'],
  [60, 'fatal'],
]);

export function installProviderLogSink(log: ProviderLogSink): void {
  setLogDestination('stderr');
  setLogSink(line => {
    const record = recordSchema.parse(JSON.parse(line));
    const level = levels.get(record.level);
    if (!level) throw new Error('Unsupported provider log level');
    // SDK errors and payloads may contain credentials or message text. Forward
    // only module identity, counters, flags and the contract's failure class.
    const bindings = Object.fromEntries(
      Object.entries(record).filter(
        ([key, value]) =>
          !['level', 'time', 'pid'].includes(key) &&
          (typeof value === 'number' || typeof value === 'boolean')
      )
    );
    const failureClass = providerFailureSchema.shape.class.safeParse(record.failureClass);
    void log({
      level,
      msg: record.msg,
      bindings: {
        ...bindings,
        ...(record.module ? { module: record.module } : {}),
        ...(failureClass.success ? { failureClass: failureClass.data } : {}),
      },
    }).catch(() => {
      process.stderr.write('provider.log_forward_failed\n');
    });
  });
}
