import { afterEach, expect, mock, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';

const mockCreateCodebase = mock(
  async (input: {
    name: string;
    repository_url?: string;
    default_cwd: string;
    default_branch: string | null;
    ai_assistant_type: string;
  }) => ({
    id: 'process-proof-codebase',
    name: input.name,
    repository_url: input.repository_url ?? null,
    default_cwd: input.default_cwd,
    default_branch: input.default_branch,
    ai_assistant_type: input.ai_assistant_type,
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);

mock.module('../db/codebases', () => ({
  createCodebase: mockCreateCodebase,
  findCodebaseByRepoUrl: mock(async () => null),
  findCodebaseByName: mock(async () => null),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => undefined),
  updateCodebase: mock(async () => undefined),
}));
mock.module('../utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));
mock.module('../config/resolve-assistant', () => ({
  resolveDefaultAssistant: mock(async () => 'codex'),
}));

const { cloneRepository } = await import('./clone');

const originalPath = process.env.PATH;
const originalArchonHome = process.env.ARCHON_HOME;
const originalGhToken = process.env.GH_TOKEN;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalGhToken;
  delete process.env.ARCHON_TEST_GIT_ARGS;
  delete process.env.ARCHON_TEST_GIT_ENV;
});

test('core clone keeps credentials out of the real child argv and persisted remote', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'archon-core-clone-'));
  const binDir = join(fixtureRoot, 'bin');
  const invocationPath = join(fixtureRoot, 'clone-args');
  const environmentPath = join(fixtureRoot, 'clone-env');
  const token = 'ghp_core_process_secret';

  try {
    await mkdir(binDir);
    await writeFile(
      join(binDir, 'git'),
      `#!/bin/sh
is_clone=0
target=""
url=""
for arg in "$@"; do
  [ "$arg" = clone ] && is_clone=1
  case "$arg" in https://*) url="$arg" ;; esac
  target="$arg"
done
if [ "$is_clone" = 1 ]; then
  printf '%s\\0' "$@" > "$ARCHON_TEST_GIT_ARGS"
  printf '%s\\n%s\\n' "$ARCHON_GIT_PASS" "$GIT_TERMINAL_PROMPT" > "$ARCHON_TEST_GIT_ENV"
  mkdir -p "$target/.git"
  printf '[remote "origin"]\\n\\turl = %s\\n' "$url" > "$target/.git/config"
  exit 0
fi
case "$*" in *"rev-parse --abbrev-ref HEAD"*) printf 'main\\n' ;; esac
`
    );
    await chmod(join(binDir, 'git'), 0o755);

    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.ARCHON_HOME = fixtureRoot;
    process.env.GH_TOKEN = token;
    process.env.ARCHON_TEST_GIT_ARGS = invocationPath;
    process.env.ARCHON_TEST_GIT_ENV = environmentPath;

    const result = await cloneRepository('https://github.com/owner/repo.git');
    const targetPath = join(fixtureRoot, 'workspaces', 'owner', 'repo', 'source');

    expect(result.alreadyExisted).toBe(false);
    expect(await readFile(invocationPath, 'utf8')).not.toContain(token);
    expect(await readFile(join(targetPath, '.git', 'config'), 'utf8')).not.toContain(token);
    expect(await readFile(environmentPath, 'utf8')).toBe(`${token}\n0\n`);
  } finally {
    await removeTempTree(fixtureRoot);
  }
});
