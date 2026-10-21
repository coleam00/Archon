import { appendFileSync } from 'node:fs';

const log = process.env.ARCHON_SPEC_SIGNAL_LOG;
const kill = process.kill.bind(process);
if (log) {
  process.kill = (pid, signal) => {
    appendFileSync(log, `${JSON.stringify({ pid, signal: signal ?? 'SIGTERM' })}\n`);
    return kill(pid, signal);
  };
}
await import('../../cli');
