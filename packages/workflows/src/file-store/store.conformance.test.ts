import { afterEach, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { describeWorkflowStoreConformance } from '../store-conformance';
import * as telemetry from '../run-terminal-telemetry';
import { createFileWorkflowStore } from './store';
import { commit } from './commit';
const roots = trackTempRoots();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
});
describeWorkflowStoreConformance('files', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'workflow-files-')));
  const reports: string[] = [];
  const spy = spyOn(telemetry, 'reportRunTerminalTelemetry').mockImplementation(run => {
    reports.push(run.id);
  });
  restore = () => spy.mockRestore();
  const store = await createFileWorkflowStore({ root });
  return {
    store,
    backdate: (id, dates) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        Object.assign(run, dates);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    terminalReports: () => reports,
    close: async () => {},
  };
});
