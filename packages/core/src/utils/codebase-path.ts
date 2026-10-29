import * as hostPath from 'node:path';
import type { PlatformPath } from 'node:path';
import { quoteCommandArg } from '../utils/command-args';

export class InvalidCodebaseDefaultCwdError extends Error {
  constructor(
    public project: string,
    public defaultCwd: string
  ) {
    super(
      `Project ${quoteCommandArg(project)} has a stored default_cwd that is not absolute: ${defaultCwd}. ` +
        `Re-register it in Archon chat with /register-project ${quoteCommandArg(project)} <absolute-path>.`
    );
    this.name = 'InvalidCodebaseDefaultCwdError';
  }
}

export function assertAbsoluteDefaultCwd(defaultCwd: string, project: string): void {
  if (!hostPath.isAbsolute(defaultCwd))
    throw new InvalidCodebaseDefaultCwdError(project, defaultCwd);
}

type DefaultCwdPathApi = Pick<PlatformPath, 'normalize' | 'parse' | 'sep'>;

/**
 * The spelling `default_cwd` lookups compare. Windows spells one directory with
 * either separator and either drive-letter case, and writers have stored both,
 * so win32 normalizes separators and uppercases the drive letter. The rest of
 * the path keeps its case, because NTFS directories can be case-sensitive.
 * POSIX compares the exact string.
 */
export function defaultCwdKey(path: string, pathApi: DefaultCwdPathApi = hostPath): string {
  if (pathApi.sep === '/') return path;
  const normalized = pathApi.normalize(path);
  const isDriveRoot = pathApi.parse(normalized).root.charAt(1) === ':';
  return isDriveRoot ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : normalized;
}

/** True when two `default_cwd` spellings name the same registration. */
export function isSameDefaultCwd(a: string, b: string, pathApi?: DefaultCwdPathApi): boolean {
  return defaultCwdKey(a, pathApi) === defaultCwdKey(b, pathApi);
}
