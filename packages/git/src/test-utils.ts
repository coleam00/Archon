import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface RecordedGitInvocation {
  argv: string[];
  env: {
    GIT_TERMINAL_PROMPT?: string;
    ARCHON_GIT_USERNAME?: string;
    ARCHON_GIT_PASSWORD?: string;
  };
}

export interface RecordingGitFixture {
  run<T>(action: () => Promise<T>, stderr?: string): Promise<T>;
  readInvocations(): Promise<RecordedGitInvocation[]>;
}

/**
 * A committed executable, not one written per test: macOS assesses each new executable
 * file on its first exec (200-370 ms measured at load 20, longer under heavy load), and
 * a fresh fake per test paid that inside the test's 5 s budget on every run.
 */
const RECORDING_GIT_BIN = join(import.meta.dir, 'test-fixtures', 'recording-git-bin');

export async function createRecordingGitFixture(root: string): Promise<RecordingGitFixture> {
  if (process.platform === 'win32') {
    throw new Error('The recording Git fixture requires a POSIX executable script');
  }

  const binPath = RECORDING_GIT_BIN;
  const recordPath = join(root, 'git-invocations.jsonl');

  return {
    async run<T>(action: () => Promise<T>, stderr?: string): Promise<T> {
      const savedPath = process.env.PATH;
      const savedRecordPath = process.env.ARCHON_TEST_GIT_RECORD_PATH;
      const savedStderr = process.env.ARCHON_TEST_GIT_STDERR;
      process.env.PATH = `${binPath}${delimiter}${savedPath ?? ''}`;
      process.env.ARCHON_TEST_GIT_RECORD_PATH = recordPath;
      if (stderr === undefined) delete process.env.ARCHON_TEST_GIT_STDERR;
      else process.env.ARCHON_TEST_GIT_STDERR = stderr;

      try {
        return await action();
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        if (savedRecordPath === undefined) delete process.env.ARCHON_TEST_GIT_RECORD_PATH;
        else process.env.ARCHON_TEST_GIT_RECORD_PATH = savedRecordPath;
        if (savedStderr === undefined) delete process.env.ARCHON_TEST_GIT_STDERR;
        else process.env.ARCHON_TEST_GIT_STDERR = savedStderr;
      }
    },

    async readInvocations(): Promise<RecordedGitInvocation[]> {
      let contents: string;
      try {
        contents = await readFile(recordPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      return contents
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as RecordedGitInvocation);
    },
  };
}
