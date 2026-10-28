import { trackTempRoots } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, mkdir as realMkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateSync } from 'zlib';
import { clearLogger, output, git, mockLogger, repo } from './test-fixtures/git-harness';
import { createRecordingGitFixture } from './test-utils';

const trackTempRoot = trackTempRoots();

/**
 * Writes a one-commit bare repository that Git's dumb HTTP transport can clone:
 * loose objects, a branch ref, HEAD and `info/refs`. Built in-process because the
 * clone is the subprocess under test; building the same fixture with `git` took
 * seven more children, the bulk of the test's Windows time (#2924).
 */
async function writeDumbHttpRepo(barePath: string): Promise<void> {
  const writeObject = async (type: string, body: Buffer): Promise<Buffer> => {
    const raw = Buffer.concat([Buffer.from(`${type} ${String(body.length)}\0`), body]);
    const id = createHash('sha1').update(raw).digest();
    const hex = id.toString('hex');
    await realMkdir(join(barePath, 'objects', hex.slice(0, 2)), { recursive: true });
    await writeFile(join(barePath, 'objects', hex.slice(0, 2), hex.slice(2)), deflateSync(raw));
    return id;
  };
  const blob = await writeObject('blob', Buffer.from('fixture\n'));
  const tree = await writeObject('tree', Buffer.concat([Buffer.from('100644 README.md\0'), blob]));
  const signature = 'Archon Test <archon@example.test> 0 +0000';
  const commit = await writeObject(
    'commit',
    Buffer.from(
      `tree ${tree.toString('hex')}\nauthor ${signature}\ncommitter ${signature}\n\nfixture\n`
    )
  );
  const head = commit.toString('hex');
  await realMkdir(join(barePath, 'refs', 'heads'), { recursive: true });
  await realMkdir(join(barePath, 'info'), { recursive: true });
  await writeFile(join(barePath, 'refs', 'heads', 'main'), `${head}\n`);
  await writeFile(join(barePath, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(barePath, 'info', 'refs'), `${head}\trefs/heads/main\n`);
}

describe('git utilities', () => {
  beforeEach(clearLogger);
  describe('cloneRepository', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('clones successfully without token', async () => {
      execSpy.mockResolvedValue(output());

      expect(
        await git.cloneRepository('https://github.com/owner/repo.git', repo('/tmp/target'))
      ).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/owner/repo.git', '/tmp/target'],
        {
          timeout: 120000,
          env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }) as NodeJS.ProcessEnv,
        }
      );
    });

    test.each([
      ['bare host', 'github.com/owner/repo.git'],
      ['SCP style', 'git@github.com:owner/repo.git'],
    ])('normalizes a supported %s source before spawning Git', async (_name, source) => {
      execSpy.mockResolvedValue(output());

      expect(await git.cloneRepository(source, repo('/tmp/target'))).toEqual({
        ok: true,
        value: undefined,
      });
      expect(execSpy.mock.calls[0]?.[1]).toContain('https://github.com/owner/repo.git');
    });

    test('passes GIT_TERMINAL_PROMPT=0 to the git clone subprocess', async () => {
      execSpy.mockResolvedValue(output());

      await git.cloneRepository('https://github.com/owner/repo.git', repo('/tmp/target'));

      const env = execSpy.mock.calls[0]![2]?.env ?? {};
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      // The rest of the environment must be inherited, not stripped. On
      // Windows the key can be 'Path' — spreading process.env keeps the
      // original casing — so locate the path key case-insensitively.
      const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path');
      expect(pathKey).toBeDefined();
      expect(env[pathKey!]).toBe(process.env[pathKey!]);
    });

    test('passes authenticated clone credentials through a scoped helper environment', async () => {
      execSpy.mockResolvedValue(output());
      const token = 'ghp_abc123';

      expect(
        await git.cloneRepository('https://github.com/owner/repo.git', repo('/tmp/target'), {
          credentials: { username: token, password: '' },
        })
      ).toEqual({ ok: true, value: undefined });
      const [, args, options] = execSpy.mock.calls[0]!;
      expect(args).toContain('https://github.com/owner/repo.git');
      expect(args.join('\0')).not.toContain(token);
      expect(args).toContain('credential.helper=');
      expect(args.some(arg => arg.startsWith('credential.https://github.com.helper='))).toBe(true);
      expect(options?.env?.ARCHON_GIT_USERNAME).toBe(token);
      expect(options?.env?.ARCHON_GIT_PASSWORD).toBe('');
    });

    test.skipIf(process.platform === 'win32')(
      'keeps authenticated clone credentials out of real child argv and origin config',
      async () => {
        execSpy.mockRestore();
        const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-clone-security-')));
        const targetPath = repo(join(root, 'clone'));
        const fixture = await createRecordingGitFixture(root);
        const token = 'real-child-token-123';

        const result = await fixture.run(() =>
          git.cloneRepository('https://github.com/owner/repo.git', targetPath, {
            credentials: { username: token, password: '' },
          })
        );

        expect(result).toEqual({ ok: true, value: undefined });
        const [clone] = await fixture.readInvocations();
        expect(clone).toBeDefined();
        expect(clone.argv.join('\0')).not.toContain(token);
        expect(clone.env.ARCHON_GIT_USERNAME).toBe(token);
        expect(clone.env.ARCHON_GIT_PASSWORD).toBe('');
        expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0');
        const originConfig = await readFile(join(targetPath, '.git', 'config'), 'utf8');
        expect(originConfig).toContain('url = https://github.com/owner/repo.git');
        expect(originConfig).not.toContain(token);
      }
    );

    test('authenticates a real Git clone against an explicit HTTP port', async () => {
      execSpy.mockRestore();
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-clone-http-auth-')));
      const servedPath = join(root, 'served');
      const barePath = join(servedPath, 'repo.git');
      const targetPath = repo(join(root, 'clone'));
      const token = 'explicit-port-token-456';
      const expectedAuthorization = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
      const authorizations: Array<string | null> = [];

      await writeDumbHttpRepo(barePath);

      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const authorization = request.headers.get('authorization');
          authorizations.push(authorization);
          if (authorization !== expectedAuthorization) {
            return new Response('authentication required', {
              status: 401,
              headers: { 'WWW-Authenticate': 'Basic realm="archon-test"' },
            });
          }

          const relativePath = decodeURIComponent(new URL(request.url).pathname).replace(
            /^\/+/,
            ''
          );
          if (!relativePath.startsWith('repo.git/'))
            return new Response('not found', { status: 404 });
          const file = Bun.file(join(servedPath, relativePath));
          if (!(await file.exists())) return new Response('not found', { status: 404 });
          return new Response(file);
        },
      });

      try {
        const url = `http://127.0.0.1:${String(server.port)}/repo.git`;
        const result = await git.cloneRepository(url, targetPath, {
          credentials: { username: 'oauth2', password: token },
        });

        expect(result).toEqual({ ok: true, value: undefined });
        expect(authorizations).toContain(expectedAuthorization);
        const originConfig = await readFile(join(targetPath, '.git', 'config'), 'utf8');
        expect(originConfig).toContain(`url = ${url}\n`);
        expect(originConfig).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });

    test('rejects a malformed credential-bearing HTTP URL before spawning Git', async () => {
      execSpy.mockResolvedValue(output());
      const credential = 'malformed-secret-123';

      const result = await git.cloneRepository(
        `https://${credential}@example.test:bad/owner/repo.git`,
        repo('/tmp/target')
      );

      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: 'Invalid HTTP(S) repository URL' },
      });
      expect(execSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(credential);
    });

    test('rejects a valid HTTP URL that already contains credentials', async () => {
      execSpy.mockResolvedValue(output());
      const credential = 'embedded-secret-456';

      const result = await git.cloneRepository(
        `  https://${credential}@example.test/owner/repo.git`,
        repo('/tmp/target')
      );

      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: 'Repository URL must not include credentials' },
      });
      expect(execSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(credential);
    });

    for (const { name, url, credential } of [
      {
        name: 'backslash userinfo',
        url: 'https://backslash-secret-789\\@127.0.0.1:9/owner/repo.git',
        credential: 'backslash-secret-789',
      },
      {
        name: 'query credentials',
        url: 'https://example.test/owner/repo.git?access_token=query-secret-789',
        credential: 'query-secret-789',
      },
      {
        name: 'fragment credentials',
        url: 'https://example.test/owner/repo.git#access_token=fragment-secret-789',
        credential: 'fragment-secret-789',
      },
      {
        name: 'bare-host query credentials',
        url: 'example.test/owner/repo.git?access_token=bare-query-secret-789',
        credential: 'bare-query-secret-789',
      },
      {
        name: 'bare-host fragment credentials',
        url: 'example.test/owner/repo.git#access_token=bare-fragment-secret-789',
        credential: 'bare-fragment-secret-789',
      },
      {
        name: 'bare-host backslash userinfo',
        url: 'bare-backslash-secret-789\\@example.test/owner/repo.git',
        credential: 'bare-backslash-secret-789',
      },
      {
        name: 'SCP-style query credentials',
        url: 'git@example.test:owner/repo.git?access_token=scp-query-secret-789',
        credential: 'scp-query-secret-789',
      },
      {
        name: 'SCP-style fragment credentials',
        url: 'git@example.test:owner/repo.git#access_token=scp-fragment-secret-789',
        credential: 'scp-fragment-secret-789',
      },
      {
        name: 'SCP-style backslash userinfo',
        url: 'git@scp-backslash-secret-789\\@example.test:owner/repo.git',
        credential: 'scp-backslash-secret-789',
      },
    ]) {
      test.skipIf(process.platform === 'win32')(
        `rejects ${name} before spawning a real child`,
        async () => {
          execSpy.mockRestore();
          const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-clone-url-reject-')));
          const fixture = await createRecordingGitFixture(root);

          const result = await fixture.run(() =>
            git.cloneRepository(url, repo(join(root, 'clone')))
          );

          expect(result).toEqual({
            ok: false,
            error: { code: 'unknown', message: 'Invalid HTTP(S) repository URL' },
          });
          expect(await fixture.readInvocations()).toEqual([]);
          expect(JSON.stringify(result)).not.toContain(credential);
          expect(mockLogger.error).not.toHaveBeenCalled();
        }
      );
    }

    test('sanitizes authenticated clone failures before returning or logging them', async () => {
      const token = 'unexpected-error-token-654';
      execSpy.mockRejectedValue(
        Object.assign(new Error(`helper failed with ${token}`), {
          stderr: `credential rejected: ${token}`,
        })
      );

      const result = await git.cloneRepository(
        'https://github.com/owner/repo.git',
        repo('/tmp/target'),
        { credentials: { username: 'x-access-token', password: token } }
      );

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(token);
      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: 'helper failed with ***\ncredential rejected: ***' },
      });
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockLogger.error.mock.calls)).toContain('***');
    });

    test.each(['', '\n', '\r\n'])(
      'classifies HTTP 403 clone stderr as permission denied (ending %j)',
      async ending => {
        const token = 'rejected-clone-token';
        const failure = new git.GitFailure(
          'unclassified',
          'git clone failed',
          Object.assign(new Error('git exited'), {
            code: 128,
            stderr: `remote: credential ${token} rejected\nfatal: unable to access 'https://gitlab.example.test/group/project.git/': The requested URL returned error: 403${ending}`,
          })
        );
        execSpy.mockRejectedValue(failure);

        const result = await git.cloneRepository(
          'https://gitlab.example.test/group/project.git',
          repo('/tmp/target'),
          { credentials: { username: 'oauth2', password: token } }
        );

        expect(result).toEqual({
          ok: false,
          error: {
            code: 'permission_denied',
            path: 'https://gitlab.example.test/group/project.git',
          },
        });
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(token);
        expect(JSON.stringify(mockLogger.error.mock.calls)).toContain(
          'The requested URL returned error: 403'
        );
        expect(failure.kind).toBe('unclassified');
      }
    );

    // stderr captured from git 2.49.0 against a local HTTP server, GitHub over SSH, and a full volume.
    test.each([
      [
        'HTTP 404',
        "Cloning into '/tmp/target'...\nremote: nope\nfatal: repository 'https://gitlab.example.test/group/project.git/' not found\n",
        { code: 'not_a_repo', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'HTTP 401 without credentials',
        "Cloning into '/tmp/target'...\nfatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled\n",
        { code: 'permission_denied', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'HTTP 401 with rejected credentials',
        "Cloning into '/tmp/target'...\nremote: auth\nfatal: Authentication failed for 'https://gitlab.example.test/group/project.git/'\n",
        { code: 'permission_denied', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'a missing GitHub repository over SSH',
        "Cloning into '/tmp/target'...\nERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
        { code: 'not_a_repo', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'a full disk',
        'fatal: write error: No space left on device\nfatal: fetch-pack: invalid index-pack output\n',
        { code: 'no_space', path: '/tmp/target' },
      ],
    ] as const)('maps clone stderr for %s to its guidance', async (_cause, stderr, error) => {
      execSpy.mockRejectedValue(
        new git.GitFailure(
          'unclassified',
          'git clone failed',
          Object.assign(new Error('git exited'), { code: 128, stderr })
        )
      );

      expect(
        await git.cloneRepository(
          'https://gitlab.example.test/group/project.git',
          repo('/tmp/target')
        )
      ).toEqual({ ok: false, error });
    });

    test.each([
      ['fatal: Authentication failed', 'The requested URL returned error: 403'],
      ['fatal: Authentication failed: HTTP 403', 'git clone failed'],
      ['fatal: The requested URL returned error: 4030\n', 'git clone failed'],
      ['fatal: The requested URL returned error: 500\n', 'git clone failed'],
      [
        "fatal: unable to access 'https://example.test/no space/not found/': Could not resolve host: example.test\n",
        'git clone failed',
      ],
    ])('keeps other clone failures unclassified: %s', async (stderr, message) => {
      execSpy.mockRejectedValue(Object.assign(new Error(message), { code: 128, stderr }));

      const result = await git.cloneRepository(
        'https://gitlab.example.test/group/project.git',
        repo('/tmp/target')
      );

      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: `${message}\n${stderr}` },
      });
    });

    test.each([
      [
        'keeps text-only repository-not-found failures unclassified',
        'fatal: repository not found',
        'https://github.com/owner/missing.git',
      ],
      [
        'keeps text-only auth failures unclassified',
        'fatal: Authentication failed',
        'https://github.com/owner/private.git',
      ],
      [
        'keeps text-only disk failures unclassified',
        'error: no space left on device',
        'https://github.com/owner/repo.git',
      ],
      [
        'returns unknown error for unexpected failures',
        'segfault',
        'https://github.com/owner/repo.git',
      ],
    ])('%s', async (_name, message, url) => {
      execSpy.mockRejectedValue(new Error(message));
      const result = await git.cloneRepository(url, repo('/tmp/target'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unknown');
    });
  });
});
