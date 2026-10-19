import { existsSync } from 'fs';
import { findRepoRoot, trustRegisteredPath } from '@archon/git';
import type { Codebase } from '../types';
import { ProjectRegistrationError } from '../handlers/clone';

export class ProjectKindDetectionError extends Error {
  constructor(cause: unknown) {
    super(
      'Could not determine whether the path is a git repository (git failed — is git installed and the path readable?). Nothing was registered; retry once the underlying issue is resolved.',
      { cause }
    );
    this.name = 'ProjectKindDetectionError';
  }
}

export async function detectProjectKind(path: string): Promise<Codebase['kind']> {
  await trustRegisteredPath(path);
  try {
    return (await findRepoRoot(path)) ? 'repo' : 'folder';
  } catch (error) {
    if (!existsSync(path)) throw new ProjectRegistrationError(`Path does not exist: ${path}`);
    throw new ProjectKindDetectionError(error);
  }
}
