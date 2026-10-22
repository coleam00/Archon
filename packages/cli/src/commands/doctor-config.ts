import { getRegistration } from '@archon/providers';
import type { MergedConfig } from '@archon/core';
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
