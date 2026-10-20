import { describe, expect, test } from 'bun:test';
import { trackTempRoots } from '@archon/paths/test-utils';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS } from '@archon/workflows/deps';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildArtifactTransferProgram,
  type TransferDirection,
} from './artifact-exchange-filesystem';

const roots = trackTempRoots();
const symlinkTest = process.platform === 'win32' ? test.skip : test;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'archon-artifact-exchange-'));
  roots(root);
  const canonical = join(root, 'canonical');
  const output = join(root, 'output');
  const outside = join(root, 'outside');
  for (const dir of [canonical, output, outside]) mkdirSync(dir);
  const put = (base: string, rel: string, bytes = 'sentinel') => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), bytes);
  };
  put(outside, 'sentinel');
  const transfer = (direction: TransferDirection, prelude = '') => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        prelude + buildArtifactTransferProgram(direction, canonical, output, '/logical/artifacts'),
      ],
      { env: { ...process.env, BUN_ENV_FILE: '' } }
    );
    return { code: result.exitCode, error: result.stderr.toString() };
  };
  return { root, canonical, output, outside, put, transfer };
}

describe('trusted artifact transfer program', () => {
  test('the minified distribution still emits a self-contained program', async () => {
    const f = fixture();
    f.put(f.output, 'report', 'binary distribution');
    const bundled = await Bun.build({
      entrypoints: [join(import.meta.dir, 'artifact-exchange-filesystem.ts')],
      target: 'bun',
      minify: true,
    });
    expect(bundled.success).toBe(true);
    const bundle = join(f.root, 'exchange.mjs');
    writeFileSync(bundle, await bundled.outputs[0].text());
    const emitted = Bun.spawnSync([
      process.execPath,
      '--no-env-file',
      '-e',
      `import { buildArtifactTransferProgram } from ${JSON.stringify(bundle)};
       process.stdout.write(buildArtifactTransferProgram('collect', ${JSON.stringify(f.canonical)},
         ${JSON.stringify(f.output)}, '/logical/artifacts'));`,
    ]);
    expect(emitted.exitCode).toBe(0);
    const collected = Bun.spawnSync([
      process.execPath,
      '--no-env-file',
      '-e',
      emitted.stdout.toString(),
    ]);
    expect(collected.stderr.toString()).toBe('');
    expect(collected.exitCode).toBe(0);
    expect(readFileSync(join(f.canonical, 'report'), 'utf8')).toBe('binary distribution');
  });

  symlinkTest(
    'an exclusive-temp collision refuses without truncating or removing the planted link',
    () => {
      const f = fixture();
      f.put(f.output, 'body', 'container');
      const collision = join(f.canonical, '.archon-transfer-collision');
      symlinkSync(join(f.outside, 'sentinel'), collision);
      f.put(f.output, '.archon-transfer-collision', 'output');
      const result = f.transfer(
        'collect',
        `import crypto from 'node:crypto'; crypto.randomUUID = () => 'collision';`
      );
      expect(result.code).not.toBe(0);
      expect(result.error).toContain('EEXIST');
      expect(lstatSync(collision).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('sentinel');
      expect(existsSync(join(f.canonical, 'body'))).toBe(false);
    }
  );

  test('publishes only engine inputs; credentials have private modes and stale copies are removed', () => {
    const f = fixture();
    f.put(f.canonical, 'nodes/a.md', 'body');
    f.put(f.canonical, '.archon/typed-artifacts/list.json', 'listing');
    f.put(f.canonical, 'report.txt', 'host report');
    for (const credential of MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS)
      f.put(f.canonical, credential, 'credential');
    expect(f.transfer('publish')).toEqual({ code: 0, error: '' });
    expect(readFileSync(join(f.output, 'nodes/a.md'), 'utf8')).toBe('body');
    expect(readFileSync(join(f.output, '.archon/typed-artifacts/list.json'), 'utf8')).toBe(
      'listing'
    );
    expect(existsSync(join(f.output, 'report.txt'))).toBe(false);
    for (const credential of MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS) {
      if (process.platform !== 'win32')
        expect(lstatSync(join(f.output, credential)).mode & 0o777).toBe(0o600);
      rmSync(join(f.canonical, credential));
    }
    expect(f.transfer('publish').code).toBe(0);
    for (const credential of MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS)
      expect(existsSync(join(f.output, credential))).toBe(false);
  });

  for (const parent of [
    'nodes',
    '.archon',
    '.archon/typed-artifacts',
    '.archon/spills',
    ...MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS.map(dirname),
  ]) {
    for (const direction of ['publish', 'collect'] as const) {
      for (const internal of [false, true]) {
        symlinkTest(
          `${direction} refuses ${parent} linked to an ${internal ? 'internal' : 'external'} directory`,
          () => {
            const f = fixture();
            const target = internal ? join(f.output, 'elsewhere') : f.outside;
            if (internal) mkdirSync(target);
            f.put(f.canonical, `${parent}/engine`, 'engine');
            mkdirSync(dirname(join(f.output, parent)), { recursive: true });
            symlinkSync(target, join(f.output, parent));
            const result = f.transfer(direction);
            expect(result.code).not.toBe(0);
            expect(result.error).toContain('refused');
            expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('sentinel');
            expect(readdirSync(f.outside)).toEqual(['sentinel']);
          }
        );
      }
    }
  }

  for (const rel of [
    'nodes/a.md',
    'nodes/a.meta.json',
    '.archon/spills/value',
    ...MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS,
  ]) {
    symlinkTest(`publish replaces leaf link ${rel} without truncating its target`, () => {
      const f = fixture();
      f.put(f.canonical, rel, 'engine bytes');
      mkdirSync(dirname(join(f.output, rel)), { recursive: true });
      symlinkSync(join(f.outside, 'sentinel'), join(f.output, rel));
      expect(f.transfer('publish').code).toBe(0);
      expect(lstatSync(join(f.output, rel)).isFile()).toBe(true);
      expect(lstatSync(join(f.output, rel)).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(f.output, rel), 'utf8')).toBe('engine bytes');
      expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('sentinel');
    });
  }

  test('collects binary bytes, updates and deletions only on collection, retaining engine namespaces and parents', () => {
    const f = fixture();
    f.put(f.canonical, 'nodes/a.md', 'engine');
    f.put(f.canonical, '.archon/list', 'engine');
    f.put(f.canonical, 'pi-home/auth.json', 'credential');
    f.put(f.canonical, 'pi-home/report', 'old');
    f.put(f.canonical, 'report', 'old');
    f.put(f.canonical, 'deleted', 'old');
    f.put(f.output, 'report', 'new');
    f.put(f.output, 'nodes/a.md', 'forged');
    f.put(f.output, '.archon/list', 'forged');
    f.put(f.output, 'pi-home/auth.json', 'forged');
    writeFileSync(join(f.output, 'binary'), Buffer.from([0, 255, 0, 128]));
    expect(readFileSync(join(f.canonical, 'report'), 'utf8')).toBe('old');
    expect(existsSync(join(f.canonical, 'deleted'))).toBe(true);
    expect(f.transfer('collect')).toEqual({ code: 0, error: '' });
    expect(readFileSync(join(f.canonical, 'report'), 'utf8')).toBe('new');
    expect(readFileSync(join(f.canonical, 'binary'))).toEqual(Buffer.from([0, 255, 0, 128]));
    expect(existsSync(join(f.canonical, 'deleted'))).toBe(false);
    expect(existsSync(join(f.canonical, 'pi-home/report'))).toBe(false);
    for (const rel of ['nodes/a.md', '.archon/list'])
      expect(readFileSync(join(f.canonical, rel), 'utf8')).toBe('engine');
    expect(readFileSync(join(f.canonical, 'pi-home/auth.json'), 'utf8')).toBe('credential');
  });

  test('reconciles ordinary file and directory replacements', () => {
    const f = fixture();
    f.put(f.canonical, 'becomes-dir', 'old');
    f.put(f.canonical, 'becomes-file/child', 'old');
    f.put(f.output, 'becomes-dir/nested/child', 'new');
    f.put(f.output, 'becomes-file', 'new');
    expect(f.transfer('collect').code).toBe(0);
    expect(readFileSync(join(f.canonical, 'becomes-dir/nested/child'), 'utf8')).toBe('new');
    expect(readFileSync(join(f.canonical, 'becomes-file'), 'utf8')).toBe('new');
  });

  symlinkTest(
    'collect materializes contained relative and logical absolute leaf links into independent regular files',
    () => {
      const f = fixture();
      f.put(f.output, 'original', 'bytes');
      chmodSync(join(f.output, 'original'), 0o6777);
      linkSync(join(f.output, 'original'), join(f.output, 'hardlink'));
      symlinkSync('original', join(f.output, 'relative'));
      symlinkSync('/logical/artifacts/original', join(f.output, 'absolute'));
      expect(f.transfer('collect')).toEqual({ code: 0, error: '' });
      for (const rel of ['original', 'hardlink', 'relative', 'absolute']) {
        const file = join(f.canonical, rel);
        expect(lstatSync(file).isSymbolicLink()).toBe(false);
        expect(lstatSync(file).mode & 0o7777).toBe(0o644);
        expect(lstatSync(file).uid).toBe(lstatSync(f.canonical).uid);
        expect(readFileSync(file, 'utf8')).toBe('bytes');
      }
      writeFileSync(join(f.canonical, 'hardlink'), 'host update');
      expect(readFileSync(join(f.canonical, 'original'), 'utf8')).toBe('bytes');
      expect(readFileSync(join(f.output, 'original'), 'utf8')).toBe('bytes');
    }
  );

  for (const kind of ['escape', 'dangling', 'cyclic', 'directory', 'linked-parent']) {
    symlinkTest(`collect refuses ${kind} links before applying any changes`, () => {
      const f = fixture();
      f.put(f.canonical, 'deleted', 'retained');
      f.put(f.output, 'valid', 'not imported');
      if (kind === 'escape') symlinkSync(join(f.outside, 'sentinel'), join(f.output, 'bad'));
      if (kind === 'dangling') symlinkSync('absent', join(f.output, 'bad'));
      if (kind === 'cyclic') symlinkSync('bad', join(f.output, 'bad'));
      if (kind === 'directory') {
        mkdirSync(join(f.output, 'dir'));
        symlinkSync('dir', join(f.output, 'bad'));
      }
      if (kind === 'linked-parent') {
        f.put(f.output, 'real/file', 'bytes');
        symlinkSync('real', join(f.output, 'alias'));
        symlinkSync('alias/file', join(f.output, 'bad'));
      }
      const result = f.transfer('collect');
      expect(result.code).not.toBe(0);
      expect(result.error).toContain('refused');
      expect(readFileSync(join(f.canonical, 'deleted'), 'utf8')).toBe('retained');
      expect(existsSync(join(f.canonical, 'valid'))).toBe(false);
      expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('sentinel');
    });
  }

  symlinkTest('deletion and replacement of destination links never touch their targets', () => {
    const f = fixture();
    symlinkSync(f.outside, join(f.canonical, 'deleted'));
    symlinkSync(join(f.outside, 'sentinel'), join(f.canonical, 'report'));
    f.put(f.output, 'report', 'output');
    expect(f.transfer('collect').code).toBe(0);
    expect(existsSync(join(f.canonical, 'deleted'))).toBe(false);
    expect(lstatSync(join(f.canonical, 'report')).isFile()).toBe(true);
    expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('sentinel');
  });

  for (const { parent, targetKind, hasFile } of [
    { parent: 'reports', targetKind: 'external', hasFile: true },
    { parent: 'reports/nested/deep', targetKind: 'internal', hasFile: false },
  ]) {
    symlinkTest(
      `collect refuses canonical ${parent} linked to ${targetKind} storage for an ${hasFile ? 'occupied' : 'empty'} output directory`,
      () => {
        const f = fixture();
        const target = targetKind === 'external' ? f.outside : join(f.canonical, 'target');
        if (targetKind === 'internal') f.put(f.canonical, 'target/sentinel');
        f.put(f.canonical, 'deleted', 'retained');
        mkdirSync(dirname(join(f.canonical, parent)), { recursive: true });
        symlinkSync(target, join(f.canonical, parent));
        mkdirSync(join(f.output, parent), { recursive: true });
        if (hasFile) f.put(f.output, `${parent}/result.txt`, 'container output');
        f.put(f.output, 'valid', 'not imported');

        const result = f.transfer('collect');
        expect(result.code).not.toBe(0);
        expect(result.error).toContain('Artifact exchange refused');
        expect(result.error).toContain('canonical parent is a symlink');
        expect(lstatSync(join(f.canonical, parent)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(f.canonical, parent))).toBe(target);
        expect(existsSync(join(f.canonical, parent, 'result.txt'))).toBe(false);
        expect(readFileSync(join(f.canonical, 'deleted'), 'utf8')).toBe('retained');
        expect(existsSync(join(f.canonical, 'valid'))).toBe(false);
        expect(readdirSync(f.outside)).toEqual(['sentinel']);
        expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('sentinel');
        if (targetKind === 'internal')
          expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('sentinel');
      }
    );
  }

  test('refuses engine file/directory conflicts without removing output', () => {
    const f = fixture();
    f.put(f.canonical, 'nodes/body', 'engine');
    f.put(f.output, 'nodes/body/child', 'container');
    expect(f.transfer('publish').error).toContain('engine leaf is a directory');
    expect(readFileSync(join(f.output, 'nodes/body/child'), 'utf8')).toBe('container');
  });

  symlinkTest('refuses FIFO output rather than blocking or publishing a special file', () => {
    const f = fixture();
    execFileSync('mkfifo', [join(f.output, 'fifo')]);
    expect(f.transfer('collect').error).toContain('regular file');
    expect(existsSync(join(f.canonical, 'fifo'))).toBe(false);
  });
});
