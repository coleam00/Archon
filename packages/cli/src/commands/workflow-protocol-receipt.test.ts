// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { maintainedProviderPluginId } from '@archon/plugin-manifest';
import { receiptPath } from '@archon/plugin-manifest/store';
import { clearRegistry, claudeDescriptor } from '@archon/providers';
import { registerHostProviders } from '@archon/core/providers/register-host-providers';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { setPlatformPolicies, clearPlatformPolicies } from '@archon/core/platforms/registry';
import { spyOnJsonStdout } from '../test-support/workflow-harness-output';
import { captureCommand } from '../test-support/command';
import { workflowListCommand, workflowTestCommand } from './workflow-query';

const trackRoot = trackTempRoots();

test('old provider receipts warn without failing workflow list or fixture testing', async () => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'workflow-protocol-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const workflow = join(project, '.archon', 'workflows', 'receipt-check');
  await mkdir(join(workflow, 'fixtures'), { recursive: true });
  await writeFile(
    join(workflow, 'check.yaml'),
    'name: receipt-check\ndescription: Test\nnodes:\n  - id: check\n    prompt: Check\n'
  );
  await writeFile(
    join(workflow, 'fixtures', 'check.stubs.yaml'),
    'fixture:\n  expect: completed\ncheck: done\n'
  );
  const id = maintainedProviderPluginId('claude');
  const file = receiptPath(join(home, 'plugins'), id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      id,
      manifest: {
        schemaVersion: 1,
        kind: 'provider',
        name: 'provider-claude',
        description: 'Claude',
        executable: 'archon-provider-claude',
      },
      tag: 'v0.13.0',
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
      descriptor: { ...claudeDescriptor, protocol: 2 },
    })
  );
  let fixtureOutput = '';
  const result = await captureCommand({ ARCHON_HOME: home }, async () => {
    clearRegistry();
    setPlatformPolicies(defaultPlatformPolicies);
    try {
      await registerHostProviders();
      await workflowListCommand(project);
      const stdout = spyOnJsonStdout();
      try {
        expect(await workflowTestCommand(project, 'receipt-check')).toBe(0);
        fixtureOutput = stdout.mock.calls.map(call => String(call[0])).join('');
      } finally {
        stdout.mockRestore();
      }
    } finally {
      clearRegistry();
      clearPlatformPolicies();
    }
  });
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain(`Plugin unavailable: ${id}`);
  expect(result.output).toContain('uses protocol 2, but this Archon requires protocol 3');
  expect(result.output).toContain('archon provider add claude');
  expect(fixtureOutput).toContain('1 passed, 0 failed');
  expect(result.output + fixtureOutput).not.toContain('workflow(s) failed to load');
  expect(result.output).not.toContain('Invalid input');
});
