# Playwright Browser Installation Issue - Root Cause Analysis

## The Problem

When attempting to crawl websites, Playwright fails with the error:
```
playwright._impl._errors.Error: BrowserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome
```

## Root Cause

The issue was introduced during the migration from `pip` to `uv` for package management (commit 9f22659).

### What Changed

**Old Dockerfile (pip-based):**
```dockerfile
# Copy Python packages from builder
COPY --from=builder /root/.local /root/.local

# Install Playwright browsers
ENV PATH=/root/.local/bin:$PATH
RUN playwright install chromium
```

**New Dockerfile (uv-based):**
```dockerfile
# Copy the virtual environment from builder
COPY --from=builder /venv /venv

# Install Playwright browsers
ENV PATH=/venv/bin:$PATH
RUN playwright install chromium
```

### Why It Broke

1. **Default Browser Location**: When `PLAYWRIGHT_BROWSERS_PATH` is not explicitly set, Playwright uses a default location (`/root/.cache/ms-playwright/`)

2. **Build vs Runtime Discrepancy**:
   - At **build time**: Playwright installs browsers to `/root/.cache/ms-playwright/`
   - At **runtime**: Playwright looks for browsers in the default location, but due to Docker layer caching or environment differences, the browsers are not accessible

3. **Missing Environment Variable**: The `PLAYWRIGHT_BROWSERS_PATH` environment variable was never set as a persistent ENV variable, only used during the RUN command (which doesn't persist to runtime)

### Why It Worked Before

The old pip-based system happened to work because:
- The user home directory (`/root`) was consistent between build and runtime
- The `.cache` directory in `/root` was implicitly included in the Docker layers
- There were fewer environmental differences between build and runtime contexts

However, this was **fragile** and relied on Docker's implicit behavior rather than explicit configuration.

## The Fix

Set `PLAYWRIGHT_BROWSERS_PATH` as a persistent environment variable:

```dockerfile
# Install Playwright browsers
ENV PATH=/venv/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install chromium
```

### Why This Works

1. **Explicit Location**: `/ms-playwright` is clearly defined and consistent
2. **Build-time**: Playwright installs browsers to `/ms-playwright`
3. **Runtime**: Playwright looks for browsers in `/ms-playwright` (same location!)
4. **Persistence**: The ENV variable persists into the running container

### Why We Don't Use `--with-deps`

The Dockerfile already manually installs all required Playwright system dependencies (lines 26-49). Using `--with-deps` would attempt to reinstall these packages, which can:
- Cause package conflicts
- Fail on certain platforms (especially Windows/WSL)
- Significantly increase build time
- Lead to build failures

## Affected Branches

- ✅ **main branch**: Fixed (commit pending)
- ✅ **feature/advanced-crawl-domain-filtering**: Fixed

## Testing

To verify the fix works:
```bash
# Rebuild and restart the server
docker compose up --build -d archon-server

# Try crawling any website
# It should now work without browser errors
```

## Lessons Learned

1. **Always set environment variables explicitly** - Don't rely on defaults
2. **ENV vs ARG**: ENV variables persist to runtime, ARG only exists at build time
3. **Test after infrastructure changes** - Package manager migrations can have subtle side effects
4. **Document non-obvious requirements** - Playwright's browser path requirement should be explicit

## Related Files

- `python/Dockerfile.server` - Main fix location
- `python/src/server/services/crawling/crawling_service.py` - Crawling service that uses Playwright
- `python/pyproject.toml` - Dependencies including crawl4ai (which uses Playwright)

## References

- Playwright documentation: https://playwright.dev/python/docs/browsers
- Docker ENV vs ARG: https://docs.docker.com/engine/reference/builder/#env
- crawl4ai library: https://github.com/unclecode/crawl4ai
