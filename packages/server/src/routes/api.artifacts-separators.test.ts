// @archon-test-isolated
// @archon-test-windows
/**
 * The artifact file route on a platform where `\` separates path segments. The rest of the
 * route's tests are in api.artifacts.test.ts; this one is Windows path behaviour, so it runs
 * in the Windows set. The harness replaces modules, so the file runs in its own process.
 */
import {
  mockGetWorkflowRun,
  mockArchonHome,
  setMockArchonHome,
  wsRoot,
  mockGetCodebase,
  MOCK_RUNNING_RUN,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('GET /api/artifacts/:runId/* path separators', () => {
  const originalMockHome = mockArchonHome;
  beforeEach(async () => {
    setMockArchonHome(await mkdtemp(join(tmpdir(), 'archon-artifacts-home-')));
    mockGetWorkflowRun.mockReset();
    mockGetCodebase.mockReset();
  });

  afterEach(async () => {
    const used = mockArchonHome;
    setMockArchonHome(originalMockHome);
    await removeTempTree(used);
  });

  test('a backslash climb out of the artifacts directory is refused on Windows', async () => {
    // The route's `..` segment check splits on `/` only. On Windows `\` is a
    // separator too, so only the containment check stops `..\` from leaving the
    // run's directory for a sibling run whose name shares this one's prefix.
    // On POSIX `\` is an ordinary filename character and the name stays inside.
    const runId = 'run-serve-backslash';
    const runsDir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs');
    await mkdir(join(runsDir, runId), { recursive: true });
    await mkdir(join(runsDir, `${runId}-old`), { recursive: true });
    await writeFile(join(runsDir, `${runId}-old`, 'plan.md'), '# another run');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const escape = encodeURIComponent(`..\\${runId}-old\\plan.md`);
    const response = await app.request(`/api/artifacts/${runId}/${escape}`);

    if (process.platform === 'win32') {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid filename' });
    } else {
      expect(response.status).toBe(404);
    }
  });
});
