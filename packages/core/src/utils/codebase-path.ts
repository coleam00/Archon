import { isAbsolute } from 'node:path';
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
  if (!isAbsolute(defaultCwd)) throw new InvalidCodebaseDefaultCwdError(project, defaultCwd);
}
