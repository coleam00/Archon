import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

const caddyBinary = Bun.which('caddy');
const dockerBinary = Bun.which('docker');
const composeAvailable =
  dockerBinary !== null &&
  Bun.spawnSync([dockerBinary, 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' })
    .exitCode === 0;

if (process.env.CI && process.platform === 'linux') {
  test('Linux CI supplies real Caddy and Compose for the authentication recipe', () => {
    expect(caddyBinary).not.toBeNull();
    expect(composeAvailable).toBe(true);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objects(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(objects);
  return isObject(value) ? [value, ...Object.values(value).flatMap(objects)] : [];
}

function run(command: string[], env?: Record<string, string | undefined>): string {
  const result = Bun.spawnSync(command, { env, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

test.skipIf(!caddyBinary || !composeAvailable)(
  'every documented Basic Auth assignment survives Compose and adapts with real Caddy',
  async () => {
    if (!caddyBinary || !dockerBinary) throw new Error('Caddy and Compose are required');
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'caddy-recipe-')));
    const config = new URL('../Caddyfile.example', import.meta.url);
    const composePath = join(root, 'compose.yml');
    const envPath = join(root, 'compose.env');
    await writeFile(
      composePath,
      'services:\n  proxy:\n    image: caddy\n    environment:\n      CADDY_BASIC_AUTH: ${CADDY_BASIC_AUTH}\n'
    );
    const hash = '$2a$14$mzq/97z9hFwkXsEuQxIIOu3RmdJT3TNBaBJzPlENPBnB2IqlvXycm';
    const sources = [
      config,
      new URL('../.env.example', import.meta.url),
      new URL('../deploy/.env.example', import.meta.url),
      new URL('../deploy/cloud-init.yml', import.meta.url),
      new URL('../packages/docs-web/src/content/docs/deployment/docker.md', import.meta.url),
    ];
    const env = { ...process.env, CADDY_BASIC_AUTH: '', DOMAIN: 'localhost', PORT: '3000' };
    const binary = caddyBinary;
    function adapt(auth: string): unknown {
      return JSON.parse(
        run([binary, 'adapt', '--config', fileURLToPath(config), '--adapter', 'caddyfile'], {
          ...env,
          CADDY_BASIC_AUTH: auth,
        })
      );
    }
    expect(objects(adapt('')).filter(value => value.handler === 'authentication')).toEqual([]);
    for (const source of sources) {
      const text = readFileSync(source, 'utf8').replaceAll('\r\n', '\n');
      const assignments = [...text.matchAll(/^([\t ]*(?:# )?)CADDY_BASIC_AUTH=([^\n]*)\n/gm)];
      expect(assignments.length, source.pathname).toBeGreaterThan(0);
      for (const match of assignments) {
        const prefix = match[1];
        const lines = text.slice(match.index).split('\n');
        const end = lines.findIndex(
          (line, index) => index > 0 && line.slice(prefix.length).trim() === "}'"
        );
        expect(end, source.pathname).toBeGreaterThan(0);
        const assignment = lines
          .slice(0, end + 1)
          .map(line => {
            expect(line.startsWith(prefix)).toBe(true);
            return line.slice(prefix.length);
          })
          .join('\n')
          .replaceAll('REPLACE_WITH_COMPLETE_HASH_OUTPUT', hash);
        expect(assignment).toStartWith("CADDY_BASIC_AUTH='");
        const auth = parseEnv(assignment).CADDY_BASIC_AUTH;
        if (auth === undefined) throw new Error(`Missing CADDY_BASIC_AUTH in ${source.pathname}`);
        expect(auth.split('\n')[1].trim()).toBe(`admin ${hash}`);
        await writeFile(envPath, assignment);
        const interpolation = run(
          [
            dockerBinary,
            'compose',
            '--env-file',
            envPath,
            '-f',
            composePath,
            'config',
            '--environment',
          ],
          { ...process.env, CADDY_BASIC_AUTH: undefined }
        );
        expect(interpolation.includes(`CADDY_BASIC_AUTH=${auth}\n`), source.pathname).toBe(true);
        const adapted = objects(adapt(auth));
        const authentication = adapted.filter(value => value.handler === 'authentication');
        expect(authentication).toHaveLength(1);
        expect(authentication[0]).toMatchObject({
          providers: { http_basic: { accounts: [{ username: 'admin', password: hash }] } },
        });
        expect(adapted).toContainEqual(
          expect.objectContaining({
            match: [{ not: [{ path: ['/internal/*', '/webhooks/*', '/api/health'] }] }],
            handle: authentication,
          })
        );
      }
    }
  },
  30000
);
