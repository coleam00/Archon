import { afterEach, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { CONFORMANCE_CODEBASE_ID, describeWorkflowStoreConformance } from '../store-conformance';
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
  const store = await createFileWorkflowStore({
    root,
    // The host's codebase records, as every conformance target registers them.
    getCodebase: async id =>
      id === CONFORMANCE_CODEBASE_ID
        ? {
            id,
            name: 'conformance',
            repository_url: null,
            default_cwd: '/conformance',
            kind: 'repo',
          }
        : null,
  });
  return {
    store,
    backdate: (id, dates) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        Object.assign(run, dates);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    seedPersistedWait: (id, wait) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        run.metadata.wait = structuredClone(wait);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    terminalReports: () => [...reports],
    close: async () => {},
  };
});
