import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('the maintained proxy and documented route contract deny internal credentials', () => {
  const caddy = readFileSync(new URL('../../../Caddyfile.example', import.meta.url), 'utf8');
  const page = readFileSync(
    new URL('./content/docs/deployment/reverse-proxy.md', import.meta.url),
    'utf8'
  );

  expect(caddy).toMatch(/^\thandle \/internal\/\* \{\s*respond "Not Found" 404\s*\}/m);
  expect(caddy).toContain('@protected not path /internal/* /webhooks/* /api/health');
  expect(page).toContain(
    '| `/internal/*` | **Never forward**, for any HTTP method. Return a proxy-generated 404 or 403. |'
  );
});
