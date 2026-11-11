/** Runs the host CLI's merged-worktree cleanup across every registered project. */

import { input, refuse } from 'archon:script';
import { archonCommand } from '../../.shared/host.ts';

const includeClosed = input('include_closed');
if (includeClosed !== 'true' && includeClosed !== 'false') {
  refuse(`include_closed must be "true" or "false"; received ${JSON.stringify(includeClosed)}`);
} else {
  try {
    const result = Bun.spawnSync(
      [
        ...archonCommand(),
        'isolation',
        'cleanup',
        '--merged',
        ...(includeClosed === 'true' ? ['--include-closed'] : []),
      ],
      { env: process.env, stdout: 'inherit', stderr: 'inherit' }
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    refuse(`merged: ${error instanceof Error ? error.message : String(error)}`);
  }
}
