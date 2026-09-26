import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MODEL_ID = 'convaiinnovations/laya';
const MODEL_REVISION = '69f17eefb6910e69dbb031dcc3c8e3f556cff267';
const MODEL_LICENSE = 'Apache-2.0';
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const SOURCE_FILES = [
  {
    repositoryPath: 'typed-decisions/model.safetensors',
    stagedPath: 'model.safetensors',
    sizeBytes: 842_609_220,
    sha256: '4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e',
    lfs: true,
  },
  {
    repositoryPath: 'typed-decisions/tokenizer/tokenizer.json',
    stagedPath: 'tokenizer/tokenizer.json',
    sizeBytes: 3_583_228,
    sha256: '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30',
    lfs: true,
  },
  {
    repositoryPath: 'typed-decisions/rl_agent_config.json',
    stagedPath: 'rl_agent_config.json',
    sizeBytes: 847,
    sha256: 'ebf0cd524d92342a6be5e48e9fca3d7c2babfb5a56ccd79d2171ef5d8c7f7be8',
    lfs: false,
  },
  {
    repositoryPath: 'typed-decisions/encoder/config.json',
    stagedPath: 'encoder/config.json',
    sizeBytes: 2_084,
    sha256: '5268d24ad3b77c8151de5dcb0762ba4391619aad9ab0bda33e36fb083cfeae6d',
    lfs: false,
  },
  {
    repositoryPath: 'typed-decisions/tokenizer/tokenizer_config.json',
    stagedPath: 'tokenizer/tokenizer_config.json',
    sizeBytes: 337,
    sha256: '08d4cf3ac4dca381759441b85b91a6d40e688471dcd33d15d6649eb0a9a854d1',
    lfs: false,
  },
] as const;

function modelScopeUrl(repositoryPath: string): URL {
  const encodedPath = repositoryPath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return new URL(
    `https://www.modelscope.cn/models/${MODEL_ID}/resolve/${MODEL_REVISION}/${encodedPath}`
  );
}

function assertAllowedUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowedHost =
    hostname === 'modelscope.cn' ||
    hostname.endsWith('.modelscope.cn') ||
    hostname === 'aliyuncs.com' ||
    hostname.endsWith('.aliyuncs.com');
  if (
    url.protocol !== 'https:' ||
    !allowedHost ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443')
  ) {
    throw new Error(`Refusing non-allowlisted ModelScope URL: ${url.origin}`);
  }
}

async function fetchAllowlisted(url: URL, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertAllowedUrl(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'accept-encoding': 'identity' },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === MAX_REDIRECTS) {
      throw new Error('ModelScope redirect was missing a location or exceeded the redirect limit');
    }
    current = new URL(location, current);
    assertAllowedUrl(current);
  }
  throw new Error('ModelScope redirect limit exceeded');
}

async function downloadAndVerify(
  file: (typeof SOURCE_FILES)[number],
  destination: string,
  signal: AbortSignal
): Promise<void> {
  const response = await fetchAllowlisted(modelScopeUrl(file.repositoryPath), signal);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`ModelScope returned HTTP ${response.status} for ${file.repositoryPath}`);
  }
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    await response.body?.cancel();
    throw new Error(`Unexpected content encoding for ${file.repositoryPath}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== file.sizeBytes) {
    await response.body?.cancel();
    throw new Error(`Unexpected content length for ${file.repositoryPath}`);
  }
  if (!response.body)
    throw new Error(`ModelScope returned an empty body for ${file.repositoryPath}`);

  const reader = response.body.getReader();
  const digest = createHash('sha256');
  const handle = await open(destination, 'wx', 0o600);
  let bytesWritten = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesWritten += value.byteLength;
      if (bytesWritten > file.sizeBytes) {
        throw new Error(`ModelScope payload exceeded expected size for ${file.repositoryPath}`);
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await handle.write(value, offset, value.byteLength - offset, null);
        if (result.bytesWritten <= 0) throw new Error(`Could not write ${file.stagedPath}`);
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }

  const actualHash = digest.digest('hex');
  if (bytesWritten !== file.sizeBytes || actualHash !== file.sha256) {
    throw new Error(`Size or SHA-256 verification failed for ${file.repositoryPath}`);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function stage(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    throw new Error(
      'Usage: bun run scripts/stage-laya-modelscope.ts [typed-decisions-source-root]'
    );
  }

  const sourceRoot = path.resolve(
    args[0] ?? path.join(homedir(), '.archon', 'laya-source', 'typed-decisions')
  );
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceRootInfo = await lstat(sourceRoot);
  if (sourceRootInfo.isSymbolicLink() || !sourceRootInfo.isDirectory()) {
    throw new Error(`Source root must be a real directory, not a symlink: ${sourceRoot}`);
  }

  const finalDirectory = path.join(sourceRoot, MODEL_REVISION);
  const lockPath = `${finalDirectory}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new Error(
        `A staging lock already exists at ${lockPath}; inspect it before removing it`
      );
    }
    throw error;
  });
  let temporaryDirectory: string | undefined;
  try {
    if (await pathExists(finalDirectory)) {
      throw new Error(`Refusing to overwrite existing source directory: ${finalDirectory}`);
    }

    temporaryDirectory = await mkdtemp(path.join(sourceRoot, `.${MODEL_REVISION}.tmp-`));
    await chmod(temporaryDirectory, 0o700);
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    try {
      for (const file of SOURCE_FILES) {
        const outputPath = path.join(temporaryDirectory, file.stagedPath);
        await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
        await downloadAndVerify(file, outputPath, abortController.signal);
      }
    } finally {
      clearTimeout(timeout);
    }

    const manifest = {
      schemaVersion: 1,
      source: `https://www.modelscope.cn/models/${MODEL_ID}`,
      modelId: MODEL_ID,
      revision: MODEL_REVISION,
      license: MODEL_LICENSE,
      files: SOURCE_FILES.map(file => ({
        repositoryPath: file.repositoryPath,
        stagedPath: file.stagedPath,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        lfs: file.lfs,
      })),
      note: 'Source checkpoint intake only; this is not an Archon runtime bundle.',
    };
    const manifestHandle = await open(
      path.join(temporaryDirectory, 'source-manifest.json'),
      'wx',
      0o600
    );
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }

    if (await pathExists(finalDirectory)) {
      throw new Error(
        `Refusing to overwrite source directory created during staging: ${finalDirectory}`
      );
    }
    await rename(temporaryDirectory, finalDirectory);
    temporaryDirectory = undefined;
    console.log(`Verified ModelScope source artifacts staged at ${finalDirectory}`);
    console.log('These source artifacts are not a loadable Archon ONNX runtime bundle.');
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

await stage().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown staging failure';
  console.error(`Laya source staging failed: ${message}`);
  process.exitCode = 1;
});
