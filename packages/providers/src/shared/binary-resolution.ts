import { statSync } from 'node:fs';

export type BinaryPathKind = 'file' | 'directory' | 'missing';

export function classifyBinaryPath(
  path: string,
  onUnexpectedStatError: (error: NodeJS.ErrnoException) => void
): BinaryPathKind {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'missing';
  } catch (error) {
    const statError = error as NodeJS.ErrnoException;
    if (statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR') {
      onUnexpectedStatError(statError);
    }
    return 'missing';
  }
}

export function appendBinaryCandidateHint(
  message: string,
  options: {
    candidatePath: string | undefined;
    binaryLabel: string;
    sourceLabel: string;
    removableSetting: string;
  }
): string {
  if (!options.candidatePath) return message;
  return (
    `${message}\n\nA ${options.binaryLabel} binary was found at ${options.candidatePath}.\n` +
    `Update ${options.sourceLabel} to that path, or remove ${options.removableSetting} to let Archon detect it.`
  );
}
