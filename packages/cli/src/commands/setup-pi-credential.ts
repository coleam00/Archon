/**
 * Reconcile the Pi credential the user just chose with keys already configured
 * elsewhere, before setup writes anything.
 *
 * Archon applies a backend key from its env over Pi's own login (see
 * `applyPiEnvOverride` in the Pi provider), so choosing Pi's login only takes
 * effect when no such key is set. A pasted key, in turn, only lands in the env
 * file when it replaces the value already there. Setup asks in both cases and
 * never removes a key the user did not agree to remove.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { cancel, confirm, isCancel, log, note, select } from '@clack/prompts';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { getArchonHome } from '@archon/paths';
import { resolveScopedEnvPath } from './setup-env';
import { cancelSetup, exitSetup, type SetupConfig } from './setup-shared';

export interface PiCredentialTarget {
  scope: 'home' | 'project';
  force: boolean;
  repoPath: string;
  targetEnvPath: string;
}

/** A dotenv file's values, or none when the file does not exist. */
function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseDotenv(readFileSync(path, 'utf8')) : {};
}

/** A parsed YAML file, or undefined when it is missing or unparseable; the latter is reported. */
function readYamlFile(path: string, envVar: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return parseYaml(readFileSync(path, 'utf8'));
  } catch {
    log.warning(`Could not parse ${path}, so setup could not check it for ${envVar}.`);
    return undefined;
  }
}

/** Whether a value would act as a key: an empty or blank string does not. */
function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** The value at `path` + `envVar` in parsed config, or undefined when any level is missing. */
function configEnvValue(config: unknown, path: readonly string[], envVar: string): unknown {
  let node: unknown = config;
  for (const key of [...path, envVar]) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Places outside the env file setup writes where `envVar` is set and would win over Pi's login. */
export function externalPiKeySources(
  envVar: string,
  target: PiCredentialTarget,
  inheritedEnv: NodeJS.ProcessEnv
): string[] {
  const sources: string[] = [];
  if (nonEmpty(inheritedEnv[envVar])) sources.push('your shell environment');
  const otherEnvPath = resolveScopedEnvPath(
    target.scope === 'home' ? 'project' : 'home',
    target.repoPath
  );
  if (otherEnvPath !== target.targetEnvPath && nonEmpty(readEnvFile(otherEnvPath)[envVar])) {
    sources.push(otherEnvPath);
  }
  const homeConfigPath = join(getArchonHome(), 'config.yaml');
  const homeConfig = readYamlFile(homeConfigPath, envVar);
  if (nonEmpty(configEnvValue(homeConfig, ['assistants', 'pi', 'env'], envVar))) {
    sources.push(`assistants.pi.env in ${homeConfigPath}`);
  }
  const repoConfigPath = join(target.repoPath, '.archon', 'config.yaml');
  const repoConfig = readYamlFile(repoConfigPath, envVar);
  if (nonEmpty(configEnvValue(repoConfig, ['assistants', 'pi', 'env'], envVar))) {
    sources.push(`assistants.pi.env in ${repoConfigPath}`);
  }
  if (nonEmpty(configEnvValue(repoConfig, ['env'], envVar))) {
    sources.push(`env in ${repoConfigPath}`);
  }
  return sources;
}

function cancelUnchanged(): never {
  cancel('Setup cancelled. Existing configuration was not changed.');
  return exitSetup(0);
}

/** The key is in the file setup writes: remove it there, keep using it, or stop. */
async function resolveSavedKey(
  envVar: string,
  targetEnvPath: string
): Promise<{ replaceKeys: string[]; keepKey: boolean }> {
  const choice = await select({
    message: `${envVar} is set in ${targetEnvPath}, and Archon uses it instead of Pi's login. What should setup do?`,
    options: [
      {
        value: 'remove',
        label: `Remove ${envVar} from that file (a backup is saved)`,
        hint: `Anything else that reads ${envVar} from that file loses it too`,
      },
      { value: 'useKey', label: `Keep ${envVar} and use it instead of Pi's login` },
      { value: 'cancel', label: 'Cancel setup' },
    ],
  });
  if (isCancel(choice)) cancelSetup();
  if (choice === 'cancel') cancelUnchanged();
  if (choice === 'useKey') return { replaceKeys: [], keepKey: true };
  return { replaceKeys: [envVar], keepKey: false };
}

/** The key is somewhere setup does not write: say where, and continue only if the user agrees. */
async function confirmExternalKeys(envVar: string, sources: string[]): Promise<void> {
  note(
    `${envVar} is set in:\n${sources.map(source => `  - ${source}`).join('\n')}\n\nArchon uses that key instead of Pi's login until it is removed there. Setup does not change these, and it cannot see codebase env vars set in the Web UI or per-user keys, which also take precedence.`,
    "Pi's login will not be used yet"
  );
  const proceed = await confirm({
    message: `Continue setup anyway? Archon keeps using ${envVar} until you remove it.`,
    initialValue: false,
  });
  if (isCancel(proceed) || !proceed) cancelUnchanged();
}

/** A pasted key replaces the saved one only if the user says so. */
async function confirmReplaceKey(envVar: string, targetEnvPath: string): Promise<string[]> {
  const replace = await confirm({
    message: `${envVar} in ${targetEnvPath} already has a different value. Replace it with the key you just entered? A backup is saved.`,
    initialValue: true,
  });
  if (isCancel(replace)) cancelSetup();
  if (replace) return [envVar];
  log.info(`Kept the existing ${envVar} in ${targetEnvPath}`);
  return [];
}

/**
 * Settle conflicts between the chosen Pi credential and keys already set. Returns the
 * keys whose saved values the env write must drop, so the new choice takes effect.
 */
export async function reconcilePiCredential(
  ai: SetupConfig['ai'],
  target: PiCredentialTarget,
  inheritedEnv: NodeJS.ProcessEnv
): Promise<string[]> {
  const envVar = ai.piApiKeyEnvVar;
  if (!ai.pi || !envVar) return [];
  // --force rewrites the target file from scratch, so nothing saved there survives.
  const saved = target.force ? {} : readEnvFile(target.targetEnvPath);
  if (ai.piApiKey) {
    const prior = saved[envVar];
    return nonEmpty(prior) && prior.trim() !== ai.piApiKey
      ? confirmReplaceKey(envVar, target.targetEnvPath)
      : [];
  }
  if (!ai.piLogin) return [];
  if (nonEmpty(saved[envVar])) {
    const { replaceKeys, keepKey } = await resolveSavedKey(envVar, target.targetEnvPath);
    // Keeping the key means Pi's login is not used, so other keys no longer matter.
    if (keepKey) return [];
    await confirmExternalSources(envVar, target, inheritedEnv);
    return replaceKeys;
  }
  await confirmExternalSources(envVar, target, inheritedEnv);
  return [];
}

/** Look for the key outside the file setup writes, and stop unless the user agrees to go on. */
async function confirmExternalSources(
  envVar: string,
  target: PiCredentialTarget,
  inheritedEnv: NodeJS.ProcessEnv
): Promise<void> {
  const sources = externalPiKeySources(envVar, target, inheritedEnv);
  if (sources.length > 0) await confirmExternalKeys(envVar, sources);
}
