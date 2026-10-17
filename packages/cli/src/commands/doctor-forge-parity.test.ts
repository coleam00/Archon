import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('Docker gh login uses the persisted server home and user', async () => {
  const doc = await Bun.file(
    resolve(import.meta.dir, '../../../docs-web/src/content/docs/deployment/docker.md')
  ).text();
  const dockerfile = await Bun.file(resolve(import.meta.dir, '../../../../Dockerfile')).text();
  const home = dockerfile.match(/^ENV HOME=(\S+)$/m)?.[1];
  expect(home).toBe('/home/appuser');
  expect(doc).toContain(`docker compose exec -u appuser -e HOME=${home} app gh auth login`);
  const compose = Bun.YAML.parse(
    await Bun.file(resolve(import.meta.dir, '../../../../docker-compose.yml')).text()
  );
  expect(compose).toMatchObject({
    services: {
      app: { volumes: expect.arrayContaining([`\${ARCHON_USER_HOME:-archon_user_home}:${home}`]) },
    },
  });
  const entrypoint = await Bun.file(
    resolve(import.meta.dir, '../../../../docker-entrypoint.sh')
  ).text();
  expect(entrypoint.split('\n').map(line => line.trim())).toContain(`fix_ownership ${home}`);
  expect(doc).not.toContain('docker compose exec app gh auth login');
});
