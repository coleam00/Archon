import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { serverReleaseAsset } from '@archon/paths/server-launch';
import { buildWebTarball, FIXTURE_INDEX_HTML } from '../test-support/web-tarball';

let binaryRoot = '';
const serverBytes = new TextEncoder().encode('server executable');
const serverHash = new Bun.CryptoHasher('sha256').update(serverBytes).digest('hex');
const webHash = new Bun.CryptoHasher('sha256')
  .update(buildWebTarball(FIXTURE_INDEX_HTML))
  .digest('hex');
const paths = { ...(await import('@archon/paths')) };
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ info: () => {}, error: () => {} }),
  getWebDistDir: (version: string) => join(binaryRoot, 'web-dist', version),
  getServerDistDir: (version: string) => join(binaryRoot, 'server', version),
  getSourceServerEntry: () => '',
  getSourceWebDistDir: () => '',
  getLogLevel: () => 'info',
  BUNDLED_IS_BINARY: true,
  BUNDLED_VERSION: 'dev',
  BUNDLED_WEB_DIST_SHA256: webHash,
  BUNDLED_SERVER_SHA256: serverHash,
}));
import { serveCommand, downloadServer } from './serve';

function fakeChild(exitCode = 0) {
  return { pid: 1234, exited: Promise.resolve(exitCode), kill: mock(() => {}) };
}

describe('binary server download and launch', () => {
  const trackTempRoot = trackTempRoots();
  const asset = serverReleaseAsset(
    `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
  );
  let fetchSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let tarball: Uint8Array<ArrayBuffer>;
  let serverPath: string;
  beforeEach(() => {
    binaryRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'serve-binary-')));
    serverPath = join(binaryRoot, 'server', 'dev', asset);
    tarball = buildWebTarball(FIXTURE_INDEX_HTML);
    fetchSpy = spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const bytes = String(url).endsWith(asset) ? serverBytes : tarball;
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    });
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
  it('fetches and verifies both missing artifacts, announces size and spawns the server', async () => {
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => fakeChild(3)
    );
    expect(await serveCommand({ port: 4567 }, spawn)).toBe(3);
    expect(readFileSync(serverPath)).toEqual(Buffer.from(serverBytes));
    if (process.platform !== 'win32') expect(statSync(serverPath).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(binaryRoot, 'web-dist', 'dev', 'index.html'), 'utf8')).toBe(
      FIXTURE_INDEX_HTML
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[0]).toEqual([
      serverPath,
      '--cli-version',
      'dev',
      '--port',
      '4567',
      '--web-dist',
      join(binaryRoot, 'web-dist', 'dev'),
    ]);
    expect(consoleLogSpy.mock.calls.flat().join(' ')).toContain(
      `vdev (${serverBytes.length} bytes)`
    );
  });
  it('uses cached artifacts without fetching', async () => {
    mkdirSync(join(binaryRoot, 'web-dist', 'dev'), { recursive: true });
    mkdirSync(join(binaryRoot, 'server', 'dev'), { recursive: true });
    writeFileSync(serverPath, serverBytes);
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => fakeChild()
    );
    expect(await serveCommand({}, spawn)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('--download-only fetches both and starts nothing', async () => {
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => fakeChild()
    );
    expect(await serveCommand({ downloadOnly: true }, spawn)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(serverPath)).toBe(true);
    expect(existsSync(join(binaryRoot, 'web-dist', 'dev', 'index.html'))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects a server checksum mismatch without installing or spawning', async () => {
    fetchSpy.mockImplementation(async () => new Response('corrupt'));
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => fakeChild()
    );
    expect(await serveCommand({}, spawn)).toBe(1);
    expect(existsSync(serverPath)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    const errors = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(errors).toContain('Checksum mismatch');
    expect(errors).toContain(`/${asset}`);
    expect(errors).toContain('archon serve --download-only');
  });
  it.each(['HTTP failure', 'checksum mismatch'])(
    'reports a web %s after installing the server, with its URL and retry command',
    async failure => {
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        if (String(url).endsWith(asset)) return new Response(serverBytes);
        return failure === 'HTTP failure'
          ? new Response('', { status: 503 })
          : new Response('corrupt web archive');
      });
      const spawn = mock(() => fakeChild());
      expect(await serveCommand({}, spawn)).toBe(1);
      expect(readFileSync(serverPath)).toEqual(Buffer.from(serverBytes));
      expect(existsSync(join(binaryRoot, 'web-dist', 'dev'))).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(spawn).not.toHaveBeenCalled();
      const errors = consoleErrorSpy.mock.calls.flat().join(' ');
      expect(errors).toContain('Failed to download web UI');
      expect(errors).toContain('/vdev/archon-web.tar.gz');
      expect(errors).toContain('archon serve --download-only');
    }
  );
  it.each([404, 500])('reports HTTP %i with the asset URL and no install', async status => {
    fetchSpy.mockImplementation(async () => new Response('', { status }));
    await expect(downloadServer('1.2.3', serverPath, asset, serverHash)).rejects.toThrow(
      `/${asset}`
    );
    expect(existsSync(serverPath)).toBe(false);
  });
  it('downloads the selected asset without resolving the host again', async () => {
    const selectedAsset = serverReleaseAsset(
      process.platform === 'win32' ? 'bun-linux-x64' : 'bun-windows-x64'
    );
    const selectedPath = join(binaryRoot, 'server', '1.2.3', selectedAsset);
    fetchSpy.mockImplementation(async () => new Response(serverBytes));
    await downloadServer('1.2.3', selectedPath, selectedAsset, serverHash);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://github.com/coleam00/Archon/releases/download/v1.2.3/${selectedAsset}`
    );
    expect(readFileSync(selectedPath)).toEqual(Buffer.from(serverBytes));
  });
  it('requires an embedded server checksum before fetching', async () => {
    await expect(downloadServer('1.2.3', serverPath, asset, '')).rejects.toThrow(
      'Missing embedded server checksum'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(serverPath)).toBe(false);
  });
});
