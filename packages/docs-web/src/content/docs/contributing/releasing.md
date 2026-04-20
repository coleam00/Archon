---
title: 릴리스
description: Archon CLI의 새 릴리스를 만드는 방법 — 버전 관리, 릴리스 절차, 문제 해결.
category: contributing
area: infra
audience: [developer]
status: current
sidebar:
  order: 3
---

이 가이드는 Archon CLI의 새 릴리스를 만드는 방법을 다룹니다. HarnessLab은 Archon fork로 운영되므로, upstream 흐름을 유지하면서 릴리스를 준비할 때 이 절차를 기준으로 삼습니다.

## 버전 관리

버전은 [Semantic Versioning](https://semver.org/)을 따릅니다.
- **Major** (1.0.0): CLI interface 또는 workflow format의 breaking change
- **Minor** (0.1.0): 새 feature, 새 workflow, 새 command
- **Patch** (0.0.1): bug fix, documentation update

버전은 root `package.json`에만 저장됩니다. 이 값이 single source of truth입니다.

## 릴리스 절차

릴리스는 `dev`를 `main`에 merge해서 만듭니다. `main`에 직접 commit하지 마세요.

### 1. 릴리스 준비

`/release` skill을 사용하세요. 또는 다음 manual step을 따릅니다.

```bash
# Ensure dev is up to date
git checkout dev
git pull origin dev

# Run full validation
bun run validate
```

`/release` skill은 다음 작업을 자동화합니다.
1. `dev`와 `main`을 비교해 changelog entry를 생성합니다.
2. root `package.json`의 버전을 올립니다. 기본은 patch이며, 다른 증가 단위는 `/release minor` 또는 `/release major`를 사용합니다.
3. Keep a Changelog format에 맞춰 `CHANGELOG.md`를 업데이트합니다.
4. `dev`에서 `main`으로 향하는 PR을 생성합니다.

### 2. Merge와 Tag

Release PR이 review되고 merge되면 다음을 실행합니다.

```bash
# Create and push the tag from main
git checkout main
git pull origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

이 작업은 GitHub Actions release workflow를 trigger하며, workflow는 다음을 수행합니다.
1. 모든 platform용 binary를 build합니다(macOS arm64/x64, Linux arm64/x64, Windows x64).
2. checksum을 생성합니다.
3. 모든 artifact를 포함한 GitHub Release를 생성합니다.

### 3. Homebrew Formula 업데이트(Optional)

Release workflow가 완료된 뒤:

```bash
# Update checksums in the Homebrew formula
./scripts/update-homebrew.sh vX.Y.Z

# Review and commit
git diff homebrew/archon.rb
git add homebrew/archon.rb
git commit -m "chore: update Homebrew formula for vX.Y.Z"
git push origin main
```

Homebrew tap(`homebrew-archon`)을 운영한다면 업데이트된 formula를 그곳에 복사하세요.

### 4. 릴리스 검증

```bash
# Test the install script (only works if repo is public)
curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash

# Verify version
archon version
```

> **참고: Private Repository 설치**
>
> repository가 private이면 anonymous user에게는 curl install script가 동작하지 않습니다.
> 대신 GitHub CLI를 사용하세요.
>
> ```bash
> # Download and install using gh (requires GitHub authentication)
> gh release download v0.2.0 --repo coleam00/Archon \
>   --pattern "archon-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" \
>   --dir /tmp/archon-install
>
> # Install the binary
> chmod +x /tmp/archon-install/archon-*
> sudo mv /tmp/archon-install/archon-* /usr/local/bin/archon
>
> # Verify
> archon version
> ```

## Manual Release (GitHub Actions를 사용할 수 없을 때)

GitHub Actions를 실행할 수 없다면(billing issue, private repo limit 등), release를 수동으로 만듭니다.

```bash
# 1. Build binaries locally (only builds for your current platform)
./scripts/build-binaries.sh

# 2. Create the release with binaries
gh release create vX.Y.Z dist/binaries/* \
  --title "Archon CLI vX.Y.Z" \
  --generate-notes

# 3. Verify the release
gh release view vX.Y.Z
```

> **참고:** Local build는 현재 platform용 binary만 생성합니다.
> Cross-platform binary가 필요하면 GitHub Actions 또는 각 platform에 대한 접근 권한이 필요합니다.

## Manual Build (테스트용)

Release를 만들지 않고 local에서 binary만 build하려면:

```bash
# Build all platform binaries
./scripts/build-binaries.sh

# Binaries are in dist/binaries/
ls -la dist/binaries/

# Generate checksums
./scripts/checksums.sh
```

## Release Workflow 상세

`.github/workflows/release.yml` workflow는 다음과 같이 동작합니다.

1. **Trigger 조건**:
   - `v*`와 일치하는 tag push
   - version input을 포함한 manual workflow dispatch

2. **Build job**(platform별 parallel 실행):
   - Bun을 설정합니다.
   - Dependency를 설치합니다.
   - `bun build --compile`로 binary를 compile합니다.
   - Artifact로 upload합니다.

3. **Release job**(모든 build가 완료된 뒤 실행):
   - 모든 artifact를 download합니다.
   - SHA256 checksum을 생성합니다.
   - 다음을 포함한 GitHub Release를 생성합니다.
     - 모든 binary attachment
     - checksums.txt
     - 자동 생성된 release note
     - 설치 안내

## 문제 해결

### GitHub Actions에서 Build 실패

Actions tab에서 구체적인 error를 확인하세요. 흔한 원인은 다음과 같습니다.
- Dependency installation failure: `bun.lock`이 commit되어 있는지 확인하세요.
- Type error: 먼저 local에서 `bun run type-check`를 실행하세요.

### Install Script 실패

Install script에는 다음이 필요합니다.
- Download용 `curl`
- Verification용 `sha256sum` 또는 `shasum`
- `/usr/local/bin`에 대한 write access 또는 custom `INSTALL_DIR`

### Checksum 불일치

사용자가 checksum failure를 보고하면:
1. Release artifact가 완전한지 확인합니다.
2. checksums.txt가 올바르게 생성됐는지 검증합니다.
3. Checksum 생성 후 binary가 수정되지 않았는지 확인합니다.

## Pre-release 버전

공개 발표 전에 release를 테스트하려면:

```bash
# Create a pre-release tag
git tag v0.3.0-beta.1
git push origin v0.3.0-beta.1
```

Pre-release(`-`가 포함된 tag)는 GitHub에서 pre-release로 표시됩니다.

## Hotfix 절차

이미 release된 버전에 긴급 fix가 필요하면:

```bash
# Create hotfix branch from tag
git checkout -b hotfix/0.2.1 v0.2.0

# Make fixes, then tag
git tag v0.2.1
git push origin v0.2.1

# Merge fixes back to dev
git checkout dev
git merge hotfix/0.2.1
git push origin dev
```
