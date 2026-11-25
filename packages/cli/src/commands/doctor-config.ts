import { join } from 'path';
import { getRegistration } from '@archon/providers';
import type { MergedConfig } from '@archon/core';
import type { CwdEnvStrip } from '@archon/paths/strip-cwd-env';
import { loadMergedConfig, type CheckResult } from './doctor-check';

/**
 * Report whether the global and repository `.archon/config.yaml` actually load.
 */
export async function checkConfigFiles(
  cwd: string = process.cwd(),
  // Injected so tests can drive both branches without the dynamic @archon/core
  // import or a config file on disk.
  load: (cwd: string) => Promise<Pick<MergedConfig, 'assistant'>> = loadMergedConfig
): Promise<CheckResult> {
  const label = 'Config files';
  try {
    const config = await load(cwd);
    return { label, status: 'pass', message: `valid (default assistant: ${config.assistant})` };
  } catch (err) {
    return { label, status: 'fail', message: (err as Error).message };
  }
}

/**
 * Warn when the configured default assistant is a deprecated provider. Skips
 * when the config cannot load: Config files already reports that failure.
 */
export async function checkProviderDeprecation(
  cwd: string = process.cwd(),
  load: (cwd: string) => Promise<Pick<MergedConfig, 'assistant'>> = loadMergedConfig
): Promise<CheckResult> {
  const label = 'Provider support';
  let assistant: string | undefined;
  try {
    assistant = (await load(cwd)).assistant;
  } catch {
    return { label, status: 'skip', message: 'config did not load' };
  }
  if (assistant === undefined)
    return { label, status: 'skip', message: 'no default provider configured' };
  const notice = getRegistration(assistant).deprecationNotice;
  return notice
    ? { label, status: 'warn', message: notice }
    : { label, status: 'pass', message: `${assistant} is supported` };
}

/**
 * Name the target repo env keys this process stripped at boot. This is where an operator
 * reads what the env-leak guard does; commands stay silent about it.
 */
export function checkCwdEnvIsolation({ cwd, files, keys }: CwdEnvStrip): CheckResult {
  const label = 'Target repo .env';
  if (keys.length === 0) return { label, status: 'skip', message: `no .env keys in ${cwd}` };
  const paths = files.map(file => join(cwd, file)).join(', ');
  const count = keys.length === 1 ? '1 key' : `${keys.length} keys`;
  return {
    label,
    status: 'pass',
    message:
      `${count} from ${paths} ${keys.length === 1 ? 'is' : 'are'} kept out of runs, so the ` +
      `target repo's secrets cannot reach Archon's processes: ${keys.join(', ')}`,
  };
}
