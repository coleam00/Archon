import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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

const RECORDING_GIT_SOURCE = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const recordPath = process.env.ARCHON_TEST_GIT_RECORD_PATH;
if (!recordPath) throw new Error('ARCHON_TEST_GIT_RECORD_PATH is required');

appendFileSync(recordPath, JSON.stringify({
  argv,
  env: {
    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
    ARCHON_GIT_USERNAME: process.env.ARCHON_GIT_USERNAME,
    ARCHON_GIT_PASSWORD: process.env.ARCHON_GIT_PASSWORD,
  },
}) + '\\n');

const cloneIndex = argv.indexOf('clone');
if (cloneIndex >= 0) {
  const failure = process.env.ARCHON_TEST_GIT_STDERR;
  if (failure) {
    process.stderr.write(failure);
    process.exit(1);
  }

  const url = argv[cloneIndex + 1];
  const targetPath = argv[cloneIndex + 2];
  const gitDir = join(targetPath, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(
    join(gitDir, 'config'),
    '[remote "origin"]\\n\\turl = ' + url + '\\n',
    'utf8'
  );
}
`;

export async function createRecordingGitFixture(root: string): Promise<RecordingGitFixture> {
  if (process.platform === 'win32') {
    throw new Error('The recording Git fixture requires a POSIX executable script');
  }

  const binPath = join(root, 'bin');
  const recordPath = join(root, 'git-invocations.jsonl');
  const gitPath = join(binPath, 'git');
  await mkdir(binPath, { recursive: true });
  await writeFile(gitPath, RECORDING_GIT_SOURCE, 'utf8');
  await chmod(gitPath, 0o755);

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
