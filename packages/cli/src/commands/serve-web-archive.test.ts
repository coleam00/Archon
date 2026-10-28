import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { buildTarGz, buildWebTarball, FIXTURE_INDEX_HTML } from '../test-support/web-tarball';
import { extractWebArchive } from './serve-web-archive';

describe('extractWebArchive', () => {
  const trackTempRoot = trackTempRoots();

  /** A fresh target inside its own root, so escapes land beside it where a test can see them. */
  function freshTarget(): { root: string; target: string } {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'serve-web-archive-')));
    const target = join(root, 'target');
    mkdirSync(target);
    return { root, target };
  }

  it('extracts the release layout: GNU headers, `./` root, long names', () => {
    // release.yml runs GNU tar with `-C packages/web/dist .`, so every name
    // starts with `./`, and a name over 100 bytes arrives as a GNU long-name entry.
    const longAsset = `assets/${'a'.repeat(120)}.js`;
    const archive = buildTarGz(
      [
        { name: './', type: 'dir' },
        { name: './assets/', type: 'dir' },
        { name: `./${longAsset}`, type: 'file', body: 'console.log(1)' },
        { name: './index.html', type: 'file', body: FIXTURE_INDEX_HTML },
      ],
      'gnu'
    );
    const { target } = freshTarget();

    expect(extractWebArchive(archive, target)).toBe(2);

    expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe(FIXTURE_INDEX_HTML);
    expect(readFileSync(join(target, longAsset), 'utf8')).toBe('console.log(1)');
    expect(readdirSync(target).sort()).toEqual(['assets', 'index.html']);
    expect(readdirSync(join(target, 'assets'))).toEqual([`${'a'.repeat(120)}.js`]);
  });

  it('strips one leading directory, like `tar --strip-components=1`', () => {
    const { target } = freshTarget();

    expect(extractWebArchive(buildWebTarball(FIXTURE_INDEX_HTML), target)).toBe(1);

    expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe(FIXTURE_INDEX_HTML);
    expect(existsSync(join(target, 'web'))).toBe(false);
  });

  it.each([
    { name: 'web/../evil.txt', type: 'file' as const, reason: 'path traversal' },
    { name: '/web/evil.txt', type: 'file' as const, reason: 'absolute path' },
    { name: 'web/evil.txt', type: 'symlink' as const, reason: "Unsupported entry type '2'" },
  ])('refuses $name ($reason) and writes nothing outside the target', ({ name, type, reason }) => {
    const archive = buildTarGz(
      [{ name, type, body: type === 'file' ? 'pwned' : undefined, linkname: '../../evil.txt' }],
      'ustar'
    );
    const { root, target } = freshTarget();

    expect(() => extractWebArchive(archive, target)).toThrow(reason);
    expect(() => extractWebArchive(archive, target)).toThrow(`"${name}"`);
    expect(existsSync(join(root, 'evil.txt'))).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });
});
