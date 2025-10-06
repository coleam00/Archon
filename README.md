# Supabase CLI

[![Coverage Status](https://coveralls.io/repos/github/supabase/cli/badge.svg?branch=main)](https://coveralls.io/github/supabase/cli?branch=main) [![Bitbucket Pipelines](https://img.shields.io/bitbucket/pipelines/supabase-cli/setup-cli/master?style=flat-square&label=Bitbucket%20Canary)](https://bitbucket.org/supabase-cli/setup-cli/pipelines) [![Gitlab Pipeline Status](https://img.shields.io/gitlab/pipeline-status/sweatybridge%2Fsetup-cli?label=Gitlab%20Canary)
](https://gitlab.com/sweatybridge/setup-cli/-/pipelines)

[Supabase](https://supabase.io) is an open source Firebase alternative. We're building the features of Firebase using enterprise-grade open source tools.

This repository contains all the functionality for Supabase CLI.

- [x] Running Supabase locally
- [x] Managing database migrations
- [x] Creating and deploying Supabase Functions
- [x] Generating types directly from your database schema
- [x] Making authenticated HTTP requests to [Management API](https://supabase.com/docs/reference/api/introduction)

## Getting started

### Install the CLI

Available via [NPM](https://www.npmjs.com) as dev dependency. To install:

```bash
npm i supabase --save-dev
```

To install the beta release channel:

```bash
npm i supabase@beta --save-dev
```

When installing with yarn 4, you need to disable experimental fetch with the following nodejs config.

```
NODE_OPTIONS=--no-experimental-fetch yarn add supabase
```

> **Note**
For Bun versions below v1.0.17, you must add `supabase` as a [trusted dependency](https://bun.sh/guides/install/trusted) before running `bun add -D supabase`.

<details>
  <summary><b>macOS</b></summary>

  Available via [Homebrew](https://brew.sh). To install:

  ```sh
  brew install supabase/tap/supabase
  ```

  To install the beta release channel:
  
  ```sh
  brew install supabase/tap/supabase-beta
  brew link --overwrite supabase-beta
  ```
  
  To upgrade:

  ```sh
  brew upgrade supabase
  ```
</details>

<details>
  <summary><b>Windows</b></summary>

  Available via [Scoop](https://scoop.sh). To install:

  ```powershell
  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase
  ```

  To upgrade:

  ```powershell
  scoop update supabase
  ```
</details>

<details>
  <summary><b>Linux</b></summary>

  Available via [Homebrew](https://brew.sh) and Linux packages.

  #### via Homebrew

  To install:

  ```sh
  brew install supabase/tap/supabase
  ```

  To upgrade:

  ```sh
  brew upgrade supabase
  ```

  #### via Linux packages

  Linux packages are provided in [Releases](https://github.com/supabase/cli/releases). To install, download the `.apk`/`.deb`/`.rpm`/`.pkg.tar.zst` file depending on your package manager and run the respective commands.

  ```sh
  sudo apk add --allow-untrusted <...>.apk
  ```

  ```sh
  sudo dpkg -i <...>.deb
  ```

  ```sh
  sudo rpm -i <...>.rpm
  ```

  ```sh
  sudo pacman -U <...>.pkg.tar.zst
  ```
</details>

<details>
  <summary><b>Other Platforms</b></summary>

  You can also install the CLI via [go modules](https://go.dev/ref/mod#go-install) without the help of package managers.

  ```sh
  go install github.com/supabase/cli@latest
  ```

  Add a symlink to the binary in `$PATH` for easier access:

  ```sh
  ln -s "$(go env GOPATH)/bin/cli" /usr/bin/supabase
  ```

  This works on other non-standard Linux distros.
</details>

<details>
  <summary><b>Community Maintained Packages</b></summary>

  Available via [pkgx](https://pkgx.sh/). Package script [here](https://github.com/pkgxdev/pantry/blob/main/projects/supabase.com/cli/package.yml).
  To install in your working directory:

  ```bash
  pkgx install supabase
  ```

  Available via [Nixpkgs](https://nixos.org/). Package script [here](https://github.com/NixOS/nixpkgs/blob/master/pkgs/development/tools/supabase-cli/default.nix).
</details>

### Run the CLI

```bash
supabase bootstrap
```

Or using npx:

```bash
npx supabase bootstrap
```

The bootstrap command will guide you through the process of setting up a Supabase project using one of the [starter](https://github.com/supabase-community/supabase-samples/blob/main/samples.json) templates.

## Docs

Command & config reference can be found [here](https://supabase.com/docs/reference/cli/about).

## Troubleshooting

### Supabase Connection Issues

If you encounter errors connecting to Supabase (404, 502, or connection refused errors):

#### Quick Diagnosis

```bash
# Run the diagnostic script
./scripts/diagnose-supabase.sh
```

#### Quick Fix

If the diagnostic shows Supabase analytics issues:

```bash
# Run the automated fix
./scripts/fix-supabase-analytics.sh

# Verify the connection
./scripts/verify-supabase-connection.sh
```

#### Common Issues

1. **Supabase returns 404 errors**
   - **Cause**: Wrong port in `SUPABASE_URL`
   - **Fix**: Ensure `.env` has `SUPABASE_URL=http://localhost:8000` (not 54321)

2. **Kong returns 502 errors**
   - **Cause**: Supabase analytics service not running or unhealthy
   - **Fix**: Run `./scripts/fix-supabase-analytics.sh`

3. **Supabase services won't start**
   - **Cause**: Missing `.env` file in Supabase project
   - **Fix**: 
     ```bash
     cd A:/Experiment/supabase/supabase-project
     cp .env.example .env
     # Edit .env and set secure passwords and LOGFLARE tokens
     ```

#### Detailed Troubleshooting

For comprehensive troubleshooting steps, see:
- [Supabase Troubleshooting Guide](./docs/SUPABASE_TROUBLESHOOTING.md)

### Docker Networking Issues

If the `archon-server` container fails to start with "Connection refused" errors:

#### Quick Fix

```bash
# 1. Ensure Supabase is running
cd A:/Experiment/supabase/supabase-project
docker compose up -d
cd -

# 2. Auto-configure Archon networking
bash scripts/auto-configure-supabase.sh

# 3. Verify setup
bash scripts/preflight-check.sh

# 4. Start Archon
docker compose up -d
```

#### Understanding the Issue

Archon containers need to communicate with Supabase containers over Docker networks. The default configuration assumes a network name that may not match your setup.

**Common symptoms:**
- `archon-server` shows "unhealthy" status
- Logs show: `httpx.ConnectError: [Errno 111] Connection refused`
- Container fails during startup when loading credentials

**Root causes:**
- Wrong SUPABASE_URL in `.env` (using `localhost` instead of service name)
- Incorrect Docker network name in `docker-compose.yml`
- Supabase containers not running

#### Diagnostic Tools

Archon provides scripts to help diagnose and fix networking issues:

```bash
# Detect your Supabase network configuration
bash scripts/detect-supabase-network.sh

# Automatically configure Archon (recommended)
bash scripts/auto-configure-supabase.sh

# Validate setup before starting
bash scripts/preflight-check.sh

# Test Supabase connectivity
bash scripts/verify-supabase-connection.sh
```

#### Detailed Guide

For comprehensive troubleshooting steps, manual configuration, and advanced scenarios, see:
- [Docker Networking Guide](./docs/DOCKER_NETWORKING.md)
- [Supabase Troubleshooting Guide](./docs/SUPABASE_TROUBLESHOOTING.md)

### Verifying Setup

After fixing Supabase issues, verify everything is working:

```bash
# 1. Verify Supabase connection
./scripts/verify-supabase-connection.sh

# 2. Start Archon services
docker compose up -d

# 3. Check service health
docker compose ps

# 4. View logs
docker compose logs -f archon-server

# 5. Access the UI
# Open: http://localhost:3737
```

## Breaking changes

We follow semantic versioning for changes that directly impact CLI commands, flags, and configurations.

However, due to dependencies on other service images, we cannot guarantee that schema migrations, seed.sql, and generated types will always work for the same CLI major version. If you need such guarantees, we encourage you to pin a specific version of CLI in package.json.

## Developing

To run from source:

```sh
# Go >= 1.22
go run . help
```
