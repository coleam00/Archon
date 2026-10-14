import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The directories a provider loads named skills from. A provider that declares
 * this loads named skills only from these roots, and refuses a named skill whose
 * directory exists but is not loadable from its enabled roots; workflow
 * validation reports that case as an error. A provider without it uses Archon's
 * shared skill roots, and validation only warns about a missing skill.
 */
export const skillDiscoverySchema = z.object({
  /** Skill directories relative to the working directory, highest precedence first. */
  project: z.array(z.string().min(1)),
  /** Skill directories relative to the user directory, highest precedence first. */
  user: z.array(z.string().min(1)),
  /**
   * The user directory: the run environment's `env` value when set, else `home`
   * relative to the home directory. Omitted: the home directory.
   */
  userDirectory: z.object({ env: z.string().min(1), home: z.string() }).optional(),
});
export type SkillDiscovery = z.infer<typeof skillDiscoverySchema>;

export interface SkillRootScope {
  /** Include the project roots. Default true. */
  includeProject?: boolean;
  /** Include the user roots. Default true. */
  includeUser?: boolean;
  /** The run environment, consulted before `process.env` for the user directory. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Absolute skill roots for a declared discovery, in precedence order. */
export function declaredSkillRoots(
  discovery: SkillDiscovery,
  cwd: string,
  scope: SkillRootScope = {}
): string[] {
  // `HOME` first: Bun's os.homedir() ignores it, which tests with a staged home rely on.
  const home = process.env.HOME ?? homedir();
  const { userDirectory } = discovery;
  const userRoot = userDirectory
    ? scope.env?.[userDirectory.env] ||
      process.env[userDirectory.env] ||
      join(home, userDirectory.home)
    : home;
  return [
    ...(scope.includeProject === false ? [] : discovery.project.map(dir => join(cwd, dir))),
    ...(scope.includeUser === false ? [] : discovery.user.map(dir => join(userRoot, dir))),
  ];
}
