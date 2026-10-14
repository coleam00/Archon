import { existsSync } from 'fs';
import { findRepoRoot } from '@archon/git';
import type { Codebase } from '../types';

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
  try {
    return (await findRepoRoot(path)) ? 'repo' : 'folder';
  } catch (error) {
    // Missing paths reach registration's existence check for its path-specific error.
    if (!existsSync(path)) return 'folder';
    throw new ProjectKindDetectionError(error);
  }
}
