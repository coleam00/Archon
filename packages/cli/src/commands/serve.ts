import { dirname } from 'path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { createLogger, getWebDistDir, BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@harneeslab/paths';

const log = createLogger('cli.serve');

const GITHUB_REPO = 'NewTurn2017/HarneesLab';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export interface ServeOptions {
  /** TCP port to bind. Ignored when downloadOnly is true. Range: 1–65535. */
  port?: number;
  /** Download the web UI and exit without starting the server. */
  downloadOnly?: boolean;
}

export async function serveCommand(opts: ServeOptions): Promise<number> {
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
  ) {
    console.error(`오류: --port는 1~65535 사이의 정수여야 합니다. 입력값: ${opts.port}`);
    return 1;
  }

  if (!BUNDLED_IS_BINARY) {
    console.error('오류: `hlab serve`는 컴파일된 binary에서만 사용할 수 있습니다.');
    console.error('개발 중에는 다음을 사용하세요: bun run dev');
    return 1;
  }

  const version = BUNDLED_VERSION;
  const webDistDir = getWebDistDir(version);

  if (!existsSync(webDistDir)) {
    try {
      await downloadWebDist(version, webDistDir);
    } catch (err) {
      const error = toError(err);
      log.error({ err: error, version, webDistDir }, 'web_dist.download_failed');
      console.error(`오류: web UI 다운로드 실패: ${error.message}`);
      return 1;
    }
  } else {
    log.info({ webDistDir }, 'web_dist.cache_hit');
  }

  if (opts.downloadOnly) {
    log.info({ webDistDir }, 'web_dist.download_completed');
    console.log(`web UI 다운로드 완료: ${webDistDir}`);
    return 0;
  }

  // Import server and start (dynamic import keeps CLI startup fast for other commands)
  try {
    const { startServer } = await import('@harneeslab/server');
    await startServer({
      webDistPath: webDistDir,
      port: opts.port,
    });
  } catch (err) {
    const error = toError(err);
    log.error({ err: error, version, webDistDir, port: opts.port }, 'server.start_failed');
    console.error(`오류: 서버 시작 실패: ${error.message}`);
    return 1;
  }

  // Block forever — Bun.serve() keeps the event loop alive, but the CLI's
  // process.exit(exitCode) would kill it. Wait on a promise that only resolves
  // on SIGINT/SIGTERM so the server stays running.
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  return 0;
}

async function downloadWebDist(version: string, targetDir: string): Promise<void> {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/hlab-web.tar.gz`;
  const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/checksums.txt`;

  log.info({ version, targetDir }, 'web_dist.download_started');
  console.log(`로컬에서 web UI를 찾지 못했습니다 — release v${version}에서 다운로드합니다...`);

  // Download checksums and tarball in parallel
  console.log(`다운로드 중: ${tarballUrl}...`);
  const [checksumsRes, tarballRes] = await Promise.all([
    fetch(checksumsUrl).catch((err: unknown) => {
      throw new Error(
        `checksums 다운로드 네트워크 오류 (${checksumsUrl}): ${(err as Error).message}`
      );
    }),
    fetch(tarballUrl).catch((err: unknown) => {
      throw new Error(`tarball 다운로드 네트워크 오류 (${tarballUrl}): ${(err as Error).message}`);
    }),
  ]);
  if (!checksumsRes.ok) {
    throw new Error(`checksums 다운로드 실패: ${checksumsRes.status} ${checksumsRes.statusText}`);
  }
  if (!tarballRes.ok) {
    throw new Error(`web UI 다운로드 실패: ${tarballRes.status} ${tarballRes.statusText}`);
  }
  const [checksumsText, tarballBuffer] = await Promise.all([
    checksumsRes.text(),
    tarballRes.arrayBuffer(),
  ]);
  const expectedHash = parseChecksum(checksumsText, 'hlab-web.tar.gz');

  // Verify checksum
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(new Uint8Array(tarballBuffer));
  const actualHash = hasher.digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(`checksum 불일치: expected ${expectedHash}, got ${actualHash}`);
  }
  console.log('checksum 검증 완료.');

  // Extract to temp dir, then atomic rename
  const tmpDir = `${targetDir}.tmp`;

  // Clean up any previous failed attempt
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Extract tarball using tar (available on macOS/Linux)
  const proc = Bun.spawn(['tar', 'xzf', '-', '-C', tmpDir, '--strip-components=1'], {
    stdin: new Uint8Array(tarballBuffer),
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderrText = await new Response(proc.stderr).text();
    cleanupAndThrow(tmpDir, `tar 압축 해제 실패 (exit ${exitCode}): ${stderrText.trim()}`);
  }

  // Verify extraction produced expected layout
  if (!existsSync(`${tmpDir}/index.html`)) {
    cleanupAndThrow(
      tmpDir,
      '압축 해제 결과가 예상과 다릅니다 — 추출된 디렉터리에 index.html이 없습니다'
    );
  }

  // Atomic move into place
  mkdirSync(dirname(targetDir), { recursive: true });
  try {
    renameSync(tmpDir, targetDir);
  } catch (err) {
    cleanupAndThrow(
      tmpDir,
      `추출된 web UI를 ${tmpDir}에서 ${targetDir}(으)로 이동하지 못했습니다: ${(err as Error).message}`
    );
  }
  console.log(`압축 해제 완료: ${targetDir}`);
}

function cleanupAndThrow(tmpDir: string, message: string): never {
  rmSync(tmpDir, { recursive: true, force: true });
  throw new Error(message);
}

/**
 * Parse a SHA-256 checksum from a checksums.txt file (sha256sum format).
 * Format: `<hash>  <filename>` or `<hash> <filename>`
 */
export function parseChecksum(checksums: string, filename: string): string {
  for (const line of checksums.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      const hash = parts[0];
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`잘못된 checksum 항목 (${filename}): "${line.trim()}"`);
      }
      return hash;
    }
  }
  throw new Error(`checksums.txt에서 ${filename} checksum을 찾지 못했습니다`);
}
