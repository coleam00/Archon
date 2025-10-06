# MCP Build Troubleshooting Guide

## Common Build Errors and Solutions

### 1. "uv: command not found" or "uv pip install failed"

**Symptoms:**
- Build fails at the `RUN uv pip install` step
- Error message mentions uv not being found

**Solutions:**
- Update the uv installation in `Dockerfile.mcp` line 7:
  ```dockerfile
  RUN pip install --no-cache-dir "uv>=0.1.0"
  ```
- Clear Docker build cache: `docker compose build archon-mcp --no-cache`

### 2. "No matching distribution found for mcp==1.12.2"

**Symptoms:**
- Build fails during dependency installation
- Error mentions specific package versions not found

**Solutions:**
- Check internet connectivity during build
- Verify PyPI is accessible: `curl https://pypi.org/pypi/mcp/json`
- Try updating package versions in `pyproject.toml` [dependency-groups] mcp section
- Add `--index-url https://pypi.org/simple` to the uv install command

### 3. "COPY failed: file not found"

**Symptoms:**
- Build fails at COPY commands (lines 18-30)
- Error mentions specific files not found

**Solutions:**
- Verify build context is correct: `docker compose config | grep context`
- Check that all files exist:
  ```bash
  cd python/
  ls -la src/server/services/mcp_service_client.py
  ls -la src/server/config/logfire_config.py
  ```
- Ensure `.dockerignore` isn't excluding necessary files

### 4. "ImportError: No module named 'mcp'" at runtime

**Symptoms:**
- Build succeeds but container fails to start
- Logs show import errors

**Solutions:**
- Verify dependencies were installed: `docker compose exec archon-mcp pip list`
- Check PYTHONPATH is set correctly (line 33 in Dockerfile.mcp)
- Rebuild without cache: `docker compose build archon-mcp --no-cache`

### 5. "Health check failed" or container in "unhealthy" state

**Symptoms:**
- Container starts but health check fails
- `docker compose ps` shows "unhealthy" status

**Solutions:**
- Check if archon-server is healthy first (MCP depends on it)
- Verify port 8051 is not already in use: `netstat -an | grep 8051`
- Check container logs: `docker compose logs archon-mcp`
- Increase health check start_period in `docker-compose.yml` line 109

### 6. "Docker snapshot error" or "failed to compute cache key"

**Symptoms:**
- Build fails with snapshot or cache-related errors
- Error mentions BuildKit or cache keys

**Solutions:**
- Clear Docker build cache:
  ```bash
  docker builder prune -af
  docker compose build archon-mcp --no-cache
  ```
- Disable BuildKit temporarily:
  ```bash
  DOCKER_BUILDKIT=0 docker compose build archon-mcp
  ```
- Check Docker disk space: `docker system df`

## Diagnostic Commands

### Check build logs
```bash
cd a:/Experiment/archon
docker compose build archon-mcp --progress=plain 2>&1 | tee mcp_build.log
```

### Verify dependencies
```bash
docker compose run --rm archon-mcp uv pip list
```

### Test imports
```bash
docker compose run --rm archon-mcp python -c "import mcp; import httpx; import pydantic; print('OK')"
```

### Check file structure
```bash
docker compose run --rm archon-mcp ls -la src/server/services/
```

## Prevention Best Practices

1. **Pin dependency versions** in `pyproject.toml` to avoid breaking changes
2. **Use multi-stage builds** to reduce image size and build time
3. **Add verification steps** in Dockerfile to catch errors early
4. **Keep uv updated** to the latest stable version
5. **Document environment requirements** in README

## Getting Help

If none of these solutions work:

1. Run the diagnostic script: `./python/verify_mcp_build.sh`
2. Collect logs: `docker compose logs archon-mcp > mcp_logs.txt`
3. Check Docker version: `docker --version` (requires 20.10+)
4. Verify system resources: `docker system df`
5. Review recent changes to `Dockerfile.mcp` or `pyproject.toml`