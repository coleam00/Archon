import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderDiagnostics } from '@archon/provider-contract';

const execFileAsync = promisify(execFile);
export async function diagnoseBinary(
  id: string,
  label: string,
  resolve: () => Promise<{ path: string; source: string } | undefined>
): Promise<ProviderDiagnostics> {
  try {
    const binary = await resolve();
    if (!binary)
      return {
        checks: [
          { id, label, status: 'skip', message: 'dev mode (SDK resolves via node_modules)' },
        ],
      };
    await execFileAsync(binary.path, ['--version'], { timeout: 5000 });
    return {
      checks: [
        { id, label, status: 'ok', message: `${binary.path} (via ${binary.source}, spawns OK)` },
      ],
    };
  } catch (error) {
    return {
      checks: [
        {
          id,
          label,
          status: 'fail',
          message: `${label} could not resolve or spawn: ${redactCredentialValues(error instanceof Error ? error.message : String(error), collectCredentialValues(process.env))}`,
          remedy: 'Install the provider CLI or configure its binary path',
        },
      ],
    };
  }
}
