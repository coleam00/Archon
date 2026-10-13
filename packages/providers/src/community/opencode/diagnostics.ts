import type { ProviderDiagnostics } from '@archon/provider-contract';
import { probeOpencodeRuntime } from './runtime';

export async function diagnoseOpencode(
  probe: typeof probeOpencodeRuntime = probeOpencodeRuntime
): Promise<ProviderDiagnostics> {
  try {
    const availability = await probe();
    switch (availability) {
      case 'ready':
        return {
          checks: [
            {
              id: 'opencode-runtime',
              label: 'OpenCode runtime',
              status: 'ok',
              message: 'embedded runtime SDK and opencode executable present (server not started)',
            },
          ],
        };
      case 'executable-missing':
        return {
          checks: [
            {
              id: 'opencode-runtime',
              label: 'OpenCode runtime',
              status: 'fail',
              message: 'opencode executable not found on PATH.',
              remedy: 'Install the OpenCode CLI and add it to PATH.',
            },
          ],
        };
      case 'sdk-entrypoint-missing':
        return {
          checks: [
            {
              id: 'opencode-runtime',
              label: 'OpenCode runtime',
              status: 'fail',
              message: '@opencode-ai/sdk resolved but the createOpencode entrypoint is missing.',
              remedy: 'Reinstall dependencies (bun install).',
            },
          ],
        };
    }
  } catch (error) {
    return {
      checks: [
        {
          id: 'opencode-runtime',
          label: 'OpenCode runtime',
          status: 'fail',
          message: `runtime SDK not resolvable: ${error instanceof Error ? error.message : String(error)}`,
          remedy: 'Reinstall dependencies (bun install).',
        },
      ],
    };
  }
}
