# Investigation: One-command web UI install via `archon serve`

**Issue**: #978 (https://github.com/coleam00/Archon/issues/978)
**Type**: ENHANCEMENT
**Investigated**: 2026-04-09T12:00:00Z

### Assessment

| Metric     | Value  | Reasoning                                                                                                                         |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Priority   | MEDIUM | High user value (removes clone+build friction), but existing Docker path and clone path work; not blocking other work              |
| Complexity | HIGH   | 8+ files across CLI, server, CI, build scripts; server refactor is the hardest part — `main()` is 600 lines with no library API   |
| Confidence | HIGH   | Clear codebase analysis, all integration points mapped, no unknowns in the download/extract path; server refactor scope is bounded |

---

## Problem Statement

The compiled Archon CLI binary includes only `packages/cli/src/cli.ts` — no server, no web UI, no `archon serve` command. Users who want the web UI must clone the entire monorepo, install Bun, run `bun install` (2274 packages), and `bun dev`. There is no one-command path to get a working web UI from the binary install.

---

## Analysis

### Change Rationale

The web UI is the most discoverable part of the product, but it's behind the highest friction install path. The proposed approach — lazy-fetching a pre-built web UI tarball from GitHub releases on first `archon serve` — keeps the CLI binary small for CLI-only users while giving web UI users a one-command experience: `brew install coleam00/archon/archon && archon serve`.

### Key Design Decision: Server as Library vs Embedded Mini-Server

The current server (`packages/server/src/index.ts`) is a 721-line script with a monolithic `main()` function (line 129-718). It has no `startServer()` export and cannot be imported as a library. Two approaches:

**Option A: Full server refactor** — Extract `main()` into an exported `startServer(opts)` function, make `@archon/server` a dependency of `@archon/cli`, compile the full server into the binary. Binary grows from ~50MB to ~65MB. All platform adapters (Slack, Telegram, GitHub, Discord) would be compiled in.

**Option B: Minimal embedded server** — Create a lightweight Hono server in `packages/cli/src/commands/serve.ts` that only registers API routes + static serving. No platform adapters. Binary stays closer to current size. Uses `registerApiRoutes()` (already exported from `packages/server/src/routes/api.ts:837`) as the core building block.

**Recommendation: Option A (full refactor)** because:
- Option B would duplicate server initialization logic and diverge over time
- Platform adapters are only instantiated when env vars are present (all conditional, see `index.ts:296-459`) — zero cost if not configured
- The binary size increase (~15MB) is acceptable
- Users get the full server experience, not a subset

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/cli/src/commands/serve.ts` | NEW | CREATE | `archon serve` command: download web-dist, start server |
| `packages/cli/src/cli.ts` | 57-82, 231, 266+ | UPDATE | Add `'serve'` to `noGitCommands`, add `case 'serve'` |
| `packages/cli/package.json` | deps | UPDATE | Add `@archon/server` and `@archon/adapters` as dependencies |
| `packages/server/src/index.ts` | 129-718 | UPDATE | Extract `main()` into exported `startServer(opts)` |
| `packages/server/src/index.ts` | 579-593 | UPDATE | Accept `webDistPath` parameter instead of computing from `import.meta.dir` |
| `.github/workflows/release.yml` | 140-173 | UPDATE | Add web UI build + tarball upload step |
| `scripts/build-binaries.sh` | — | NONE | No change needed — `bun build --compile` follows imports automatically |
| `packages/paths/src/archon-paths.ts` | — | UPDATE | Add `getWebDistPath(version)` helper |
| Tests | NEW | CREATE | Cover download, checksum, extraction, server startup from CLI |

### Integration Points

- `packages/cli/src/cli.ts:57-82` imports all commands after dotenv setup
- `packages/server/src/routes/api.ts:837` exports `registerApiRoutes(app, webAdapter, lockManager)` — the only reusable server building block
- `packages/paths/src/bundled-build.ts` provides `BUNDLED_VERSION` for constructing release URLs
- `packages/paths/src/archon-paths.ts:56-74` provides `getArchonHome()` for cache location
- `packages/server/src/index.ts:581-593` resolves `webDistPath` from `import.meta.dir` — needs parameterization
- `.github/workflows/release.yml:163-173` publishes release assets via `softprops/action-gh-release@v2`

### Git History

- **Server last touched**: `4b2bcb0e` (env-leak-gate polish) — active development area
- **CLI last touched**: `dddff870` (embed git commit hash in version) — recent changes
- **Build scripts**: `9adc54af` (wire release workflow to build-binaries.sh) — recently stabilized

---

## Implementation Plan

### Step 1: Extract `startServer(opts)` from server's `main()`

**File**: `packages/server/src/index.ts`
**Lines**: 129-718
**Action**: UPDATE

**Current code (simplified):**
```typescript
async function main(): Promise<void> {
  // 600 lines of initialization, adapter creation, route registration, Bun.serve()
}

main().catch(error => { ... process.exit(1); });
```

**Required change:**

```typescript
export interface ServerOptions {
  /** Override the web dist path (for CLI binary with downloaded web-dist) */
  webDistPath?: string;
  /** Override the port */
  port?: number;
  /** Skip platform adapter initialization (CLI serve mode) */
  skipPlatformAdapters?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  // Move entire main() body here
  // Replace webDistPath computation (lines 584-588) with:
  //   opts.webDistPath ?? pathModule.join(pathModule.dirname(pathModule.dirname(import.meta.dir)), 'web', 'dist')
  // Replace port with: opts.port ?? getPort()
  // Wrap platform adapter blocks with: if (!opts.skipPlatformAdapters) { ... }
}

// Keep backward compat: script entry point still works
if (import.meta.main) {
  startServer().catch(error => {
    getLog().fatal({ error: error instanceof Error ? error.message : String(error) }, 'startup_failed');
    process.exit(1);
  });
}
```

**Why**: Makes the server importable as a library. `import.meta.main` guard ensures the file still works as a standalone script for `bun dev`.

---

### Step 2: Add `getWebDistDir()` path helper

**File**: `packages/paths/src/archon-paths.ts`
**Action**: UPDATE

**Add function:**
```typescript
/**
 * Returns the path to the cached web UI distribution for a given version.
 * Example: ~/.archon/web-dist/v0.3.2/
 */
export function getWebDistDir(version: string): string {
  return join(getArchonHome(), 'web-dist', version);
}
```

**Why**: Centralizes the cache location logic, consistent with existing `getArchonHome()` patterns.

---

### Step 3: Create `archon serve` command

**File**: `packages/cli/src/commands/serve.ts`
**Action**: CREATE

```typescript
import { existsSync } from 'fs';
import { createLogger, getWebDistDir } from '@archon/paths';
import { BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@archon/paths/bundled-build';

const log = createLogger('cli.serve');

const GITHUB_REPO = 'coleam00/Archon';

interface ServeOptions {
  port?: number;
  downloadOnly?: boolean;
}

export async function serveCommand(opts: ServeOptions): Promise<number> {
  const version = BUNDLED_IS_BINARY ? BUNDLED_VERSION : 'dev';
  
  if (version === 'dev') {
    console.error('Error: `archon serve` is for compiled binaries only.');
    console.error('For development, use: bun run dev');
    return 1;
  }

  const webDistDir = getWebDistDir(version);

  if (!existsSync(webDistDir)) {
    await downloadWebDist(version, webDistDir);
  }

  if (opts.downloadOnly) {
    log.info({ webDistDir }, 'web_dist.download_completed');
    console.log(`Web UI downloaded to: ${webDistDir}`);
    return 0;
  }

  // Import server and start
  const { startServer } = await import('@archon/server');
  await startServer({
    webDistPath: webDistDir,
    port: opts.port,
    skipPlatformAdapters: false, // Start all configured adapters
  });

  // Server runs until SIGINT/SIGTERM — never returns
  return 0;
}

async function downloadWebDist(version: string, targetDir: string): Promise<void> {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/archon-web.tar.gz`;
  const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/checksums.txt`;

  console.log(`Web UI not found locally — downloading from release v${version}...`);

  // Download checksums
  const checksumsRes = await fetch(checksumsUrl);
  if (!checksumsRes.ok) {
    throw new Error(`Failed to download checksums: ${checksumsRes.status} ${checksumsRes.statusText}`);
  }
  const checksumsText = await checksumsRes.text();
  const expectedHash = parseChecksum(checksumsText, 'archon-web.tar.gz');

  // Download tarball
  console.log(`Downloading ${tarballUrl}...`);
  const tarballRes = await fetch(tarballUrl);
  if (!tarballRes.ok) {
    throw new Error(`Failed to download web UI: ${tarballRes.status} ${tarballRes.statusText}`);
  }
  const tarballBuffer = await tarballRes.arrayBuffer();

  // Verify checksum
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(new Uint8Array(tarballBuffer));
  const actualHash = hasher.digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  console.log('Checksum verified.');

  // Extract to temp dir, then atomic rename
  const tmpDir = `${targetDir}.tmp`;
  const { mkdirSync, renameSync, rmSync } = await import('fs');
  
  // Clean up any previous failed attempt
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Extract tarball using tar (available on macOS/Linux)
  const proc = Bun.spawn(['tar', 'xzf', '-', '-C', tmpDir, '--strip-components=1'], {
    stdin: new Uint8Array(tarballBuffer),
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`tar extraction failed with exit code ${exitCode}`);
  }

  // Atomic move
  renameSync(tmpDir, targetDir);
  console.log(`Extracted to ${targetDir}`);
}

function parseChecksum(checksums: string, filename: string): string {
  for (const line of checksums.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      return parts[0];
    }
  }
  throw new Error(`Checksum not found for ${filename} in checksums.txt`);
}
```

**Why**: Self-contained command following existing CLI patterns. Atomic extraction prevents half-broken state. Checksum verification prevents supply chain attacks.

---

### Step 4: Wire `serve` into CLI command dispatch

**File**: `packages/cli/src/cli.ts`
**Lines**: 57-82, 231, 266+
**Action**: UPDATE

**Change 1** — Add import (after line 82):
```typescript
import { serveCommand } from './commands/serve.js';
```

**Change 2** — Add to `noGitCommands` (line 231):
```typescript
const noGitCommands = ['version', 'help', 'setup', 'chat', 'continue', 'serve'];
```

**Change 3** — Add case in switch (after the existing `case 'continue'` block):
```typescript
case 'serve': {
  const servePort = values.port ? Number(values.port) : undefined;
  const downloadOnly = Boolean(values['download-only']);
  return await serveCommand({ port: servePort, downloadOnly });
}
```

**Change 4** — Add `--port` and `--download-only` to `parseArgs` options:
```typescript
port: { type: 'string' },
'download-only': { type: 'boolean', default: false },
```

**Change 5** — Update `printUsage()` to include `serve`:
```
  serve              Start the web UI server (downloads web UI on first run)
    --port <port>       Override server port (default: 3090)
    --download-only     Download web UI without starting the server
```

**Why**: Follows exact patterns of existing commands. `serve` doesn't need a git repo.

---

### Step 5: Add `@archon/server` dependency to CLI package

**File**: `packages/cli/package.json`
**Action**: UPDATE

Add to `dependencies`:
```json
"@archon/server": "workspace:*",
"@archon/adapters": "workspace:*"
```

**Why**: The CLI needs to import `startServer` from `@archon/server`. `@archon/adapters` is a transitive dependency of `@archon/server` and should be explicit.

---

### Step 6: Update release CI to build and publish web UI tarball

**File**: `.github/workflows/release.yml`
**Action**: UPDATE

**Add new job** (or add steps to existing `release` job, after artifact download):

```yaml
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build web UI
        run: bun --filter @archon/web run build

      - name: Package web dist
        run: |
          tar czf dist/archon-web.tar.gz -C packages/web/dist .

      - name: Generate checksums
        run: |
          cd dist
          sha256sum archon-* archon-web.tar.gz > checksums.txt
          cat checksums.txt
```

**Update** the `files:` block in the release step:
```yaml
          files: |
            dist/archon-*
            dist/archon-web.tar.gz
            dist/checksums.txt
```

**Why**: Publishes a single platform-independent web UI tarball alongside the existing per-platform binaries. Checksums cover all artifacts.

---

### Step 7: Add/Update Tests

**File**: `packages/cli/src/commands/serve.test.ts`
**Action**: CREATE

**Test cases to add:**

```typescript
describe('serveCommand', () => {
  it('should reject in dev mode (non-binary)', () => {
    // Mock BUNDLED_IS_BINARY = false
    // Expect exit code 1 with "compiled binaries only" message
  });

  it('should download web-dist when not cached', () => {
    // Mock fetch to return tarball + checksums
    // Verify extraction to correct path
  });

  it('should skip download when already cached', () => {
    // Pre-create the web-dist dir
    // Verify no fetch calls
  });

  it('should fail on checksum mismatch', () => {
    // Mock fetch with wrong checksum
    // Expect error, no leftover .tmp dir
  });

  it('should handle network failure gracefully', () => {
    // Mock fetch to throw
    // Expect actionable error message
  });

  it('should support --download-only', () => {
    // Mock fetch, run with downloadOnly: true
    // Verify no startServer call
  });
});

describe('parseChecksum', () => {
  it('should extract hash for matching filename', () => {
    // Known checksums.txt format
  });

  it('should throw for missing filename', () => {
    // checksums.txt without the expected entry
  });
});
```

---

## Patterns to Follow

**From codebase — mirror these exactly:**

```typescript
// SOURCE: packages/cli/src/commands/version.ts:79-88
// Pattern for binary detection
if (BUNDLED_IS_BINARY) {
  version = BUNDLED_VERSION;
  gitCommit = BUNDLED_GIT_COMMIT;
} else {
  const devInfo = await getDevVersion();
  version = devInfo.version;
  gitCommit = await getDevGitCommit();
}
```

```typescript
// SOURCE: packages/paths/src/archon-paths.ts:56-74
// Pattern for path resolution with ARCHON_HOME override
export function getArchonHome(): string {
  if (isDocker()) {
    return '/.archon';
  }
  const envHome = process.env.ARCHON_HOME;
  if (envHome) { /* ... */ return expandTilde(envHome); }
  return join(homedir(), '.archon');
}
```

```typescript
// SOURCE: packages/server/src/index.ts:579-593
// Pattern for static file serving (to be parameterized)
if (process.env.NODE_ENV === 'production' || !process.env.WEB_UI_DEV) {
  const { serveStatic } = await import('hono/bun');
  app.use('/assets/*', serveStatic({ root: webDistPath }));
  app.get('*', serveStatic({ root: webDistPath, path: 'index.html' }));
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|---------------|------------|
| Server refactor breaks `bun dev` | `import.meta.main` guard keeps script-mode working; test both paths |
| Binary size bloat from including server | Monitor: current ~50MB, expected ~65MB. Acceptable for the value. |
| Tarball extraction fails (permissions, disk space) | Atomic extraction (`.tmp` → rename); clean up on failure; clear error message |
| GitHub release rate limiting | `fetch` will return 403 — surface the error with retry suggestion |
| Air-gapped environments | `--download-only` allows pre-caching; future `--web-dist <path>` for offline |
| Version mismatch (binary v0.3.2 but no release exists yet) | Fail with "release not found" — only happens if someone builds from source with wrong version |
| `tar` not available on system | Available on all macOS/Linux; for Windows, use Bun's built-in tar or `decompress` |
| Concurrent `archon serve` calls during first download | Atomic rename prevents corruption; second process sees complete dir or retries |
| `@archon/server` import increases CLI startup time | Use dynamic `await import()` in serve command only — other commands unaffected |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun run test
bun run lint
bun run validate  # Full pre-PR validation
```

### Manual Verification

1. Run `bun run dev` — verify server still starts normally (script mode preserved)
2. Build binary: `VERSION=test scripts/build-binaries.sh` — verify it compiles
3. Run binary with `archon serve` — verify download + extraction + server start
4. Run binary with `archon serve --download-only` — verify download without server
5. Run binary with `archon serve` a second time — verify cached (no download)
6. Run `archon workflow list` — verify no startup time regression from server dep
7. Verify `archon serve --port 4000` — verify port override works

---

## Scope Boundaries

**IN SCOPE:**
- Server library refactor (extract `startServer()`)
- `archon serve` CLI command with download + checksum + extract
- `--port` and `--download-only` flags
- Release CI changes to build and publish `archon-web.tar.gz`
- Path helper for web-dist cache location
- Tests for download/extract/checksum logic

**OUT OF SCOPE (do not touch):**
- `bun dev` workflow — stays as-is for contributors
- Docker image — orthogonal, not affected
- CDN mirroring — GitHub releases sufficient for now
- `archon serve --web-version=latest` — defer to future issue
- `archon serve --offline --web-dist=./path` — defer (can add later)
- Homebrew formula changes — just update docs, no formula change needed
- Auto-update of cached web-dist — version-keyed dirs handle this naturally
- Deprecating clone-and-bun-dev — keep for contributors
- Platform adapter lazy loading optimization — all adapters already conditional on env vars

---

## Implementation Order

The steps have a strict dependency chain:

1. **Step 2** (path helper) — no deps, can go first
2. **Step 1** (server refactor) — the hardest part, do early
3. **Step 5** (CLI package.json dep) — needed before Step 3
4. **Step 3** (serve command) — depends on Steps 1, 2, 5
5. **Step 4** (CLI wiring) — depends on Step 3
6. **Step 7** (tests) — depends on Steps 3, 4
7. **Step 6** (CI changes) — independent, can be done in parallel with 3-7

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-04-09T12:00:00Z
- **Artifact**: `.claude/PRPs/issues/issue-978.md`
