import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runDefinitionsPlan } from './workflow-run-definitions';

const track = trackTempRoots();

/** A host with no registered project: the first run registers it. */
const unregistered = {
  records: {
    codebases: {
      findCodebaseByDefaultCwd: async () => null,
      findCodebaseByPathPrefix: async () => null,
      listCodebaseClaims: async () => [],
    },
  },
} as unknown as WorkflowHost;

describe("a fresh run's definitions plan", () => {
  test('reads the base branch an unregistered project is registered with', async () => {
    const checkout = track(realpathSync(mkdtempSync(join(tmpdir(), 'archon-plan-'))));
    Bun.spawnSync(['git', 'init', '-q', checkout]);

    const plan = await runDefinitionsPlan(unregistered, checkout, {
      registrationBaseBranch: 'dev',
    });

    expect(plan).toMatchObject({ kind: 'base', checkout, defaultBranch: 'dev' });
  });
});
