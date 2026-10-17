import { spyOn } from 'bun:test';
import { format } from 'node:util';
import { closeDatabase } from '@archon/core/db/connection';
import { getLogLevel, setLogLevel, setLogSink } from '@archon/paths';

export async function captureCommand(
  env: NodeJS.ProcessEnv,
  command: () => Promise<void>
): Promise<{ status: number; stdout: string; stderr: string; output: string }> {
  const saved = { ...process.env };
  const level = getLogLevel();
  let stdout = '';
  let stderr = '';
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += `${format(...args)}\n`;
  });
  const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += `${format(...args)}\n`;
  });
  setLogSink(line => {
    stderr += line;
  });
  Object.assign(process.env, { DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1' }, env);
  setLogLevel('debug');
  let status = 0;
  try {
    await command();
  } catch (error) {
    status = 1;
    stderr += `${error instanceof Error ? error.message : String(error)}\n`;
  } finally {
    try {
      await closeDatabase();
    } finally {
      log.mockRestore();
      error.mockRestore();
      setLogSink(undefined);
      setLogLevel(level);
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  }
  return { status, stdout, stderr, output: stdout + stderr };
}

export async function captureWorkflowCommand(
  archonHome: string,
  command: (host: import('@archon/core/workflows/host-store').WorkflowHost) => Promise<void>
): ReturnType<typeof captureCommand> {
  return captureCommand({ ARCHON_HOME: archonHome }, async () => {
    const { setPlatformPolicies } = await import('@archon/core/platforms/registry');
    const { defaultPlatformPolicies } = await import('@archon/adapters/platform-policies');
    const { registerHostProviders } = await import(
      '@archon/core/providers/register-host-providers'
    );
    const { clearRegistry } = await import('@archon/providers');
    const { registerGitHubAppAuthProvider } = await import('@archon/core/workflows/store-adapter');
    const { createCliWorkflowHost } = await import('../utils/workflow-host');
    setPlatformPolicies(defaultPlatformPolicies);
    clearRegistry();
    registerGitHubAppAuthProvider(null);
    try {
      await registerHostProviders();
      await command(await createCliWorkflowHost(true));
    } finally {
      clearRegistry();
      registerGitHubAppAuthProvider(null);
    }
  });
}
