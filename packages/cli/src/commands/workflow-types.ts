import { loadConfig } from '@archon/core/config/config-loader';
import { providerRegistry } from '@archon/providers';
import { generateOutputTypes } from '@archon/workflows/output-types';
import { writeJsonLine, writeStdout } from '../utils/stdout';

/**
 * `workflow types`: generate, or with `--check` compare, the TypeScript of a pack's or
 * workflow's declared node outputs. Returns the exit code: 1 only for a stale check.
 */
export async function workflowTypesCommand(
  invokingCwd: string,
  target: string,
  options: { json?: boolean; check?: boolean; out?: string } = {}
): Promise<number> {
  const { resolveDiscoveryCwd } = await import('../utils/project-cwd');
  const cwd = await resolveDiscoveryCwd(invokingCwd);
  const config = await loadConfig(cwd);
  const result = await generateOutputTypes({
    cwd,
    targetCwd: invokingCwd,
    target,
    check: options.check === true,
    providers: providerRegistry,
    envVarNames: Object.keys(config.envVars ?? {}),
    ...(options.out !== undefined ? { out: options.out } : {}),
  });
  const stale = result.status === 'stale';
  if (options.json) {
    await writeJsonLine({ ok: !stale, ...result });
  } else if (stale) {
    const out = options.out === undefined ? '' : ` --out ${options.out}`;
    console.error(
      `Error: ${result.path} is missing or stale. Run 'archon workflow types ${target}${out}' and commit the result.`
    );
  } else {
    const counts = `${String(result.nodes)} node output(s) in ${String(result.workflows)} workflow(s)`;
    const verb = { written: 'Wrote', unchanged: 'Unchanged:', current: 'Up to date:' }[
      result.status
    ];
    await writeStdout(`${verb} ${result.path} (${counts})\n`);
  }
  return stale ? 1 : 0;
}
