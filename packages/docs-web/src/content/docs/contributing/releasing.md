---
title: 릴리스
description: HarneesLab CLI의 새 릴리스를 만드는 방법 — 버전 관리, 릴리스 절차, Homebrew 자동화, 문제 해결.
category: contributing
area: infra
audience: [developer]
status: current
sidebar:
  order: 3
---

이 가이드는 HarneesLab CLI의 새 릴리스를 만드는 방법을 다룹니다. HarneesLab은 독립 버전 라인을 사용하며 `0.1.0`부터 시작합니다.

## 버전 관리

버전은 [Semantic Versioning](https://semver.org/)을 따릅니다.
- **Major** (1.0.0): CLI interface 또는 workflow format의 breaking change
- **Minor** (0.1.0): 새 feature, 새 workflow, 새 command
- **Patch** (0.0.1): bug fix, documentation update

버전은 root `package.json`에 저장됩니다. 이 값이 single source of truth이며 `packages/*/package.json`은 release helper가 자동으로 동기화합니다.

로컬에서 버전을 확인하거나 올릴 때는 다음 helper를 사용합니다.

```bash
# 현재 버전
bun run version:harneeslab -- current

# 다음 patch/minor/major 버전 미리보기
bun run version:harneeslab -- next patch
bun run version:harneeslab -- next minor

# 모든 workspace package 버전 동기화
bun run version:harneeslab -- bump patch
bun run version:harneeslab -- set 0.1.0

# 현재 버전의 release tag 출력
bun run version:harneeslab -- tag
```

## 릴리스 절차

릴리스는 GitHub Actions의 **HarneesLab Release** workflow로 만듭니다. 이 workflow가 버전 bump, release tag 생성, binary release workflow trigger를 처리합니다.

### 1. 릴리스 준비

릴리스 전에 `dev`가 배포 가능한 상태인지 확인합니다.

```bash
# Ensure dev is up to date
git checkout dev
git pull origin dev

# Run full validation
bun run validate
```

### 2. Version Bump와 Tag

GitHub Actions에서 **HarneesLab Release**를 실행합니다.

- `target_branch`: 보통 `dev`
- `version`: 특정 버전을 직접 지정할 때 사용합니다. 예: `0.1.0`
- `bump`: `version`이 비어 있을 때 `patch`, `minor`, `major` 중 하나를 선택합니다. 현재 버전을 그대로 release하려면 `none`을 선택합니다.

workflow는 다음을 수행합니다.
1. root/package workspace 버전을 동기화합니다.
2. 필요하면 `chore: release vX.Y.Z` commit을 `target_branch`에 push합니다.
3. `vX.Y.Z` tag를 생성하고 push합니다.
4. tag push로 `.github/workflows/release.yml`을 trigger합니다.

Release workflow는 다음을 수행합니다.
1. 모든 platform용 binary를 build합니다(macOS arm64/x64, Linux arm64/x64, Windows x64).
2. checksum을 생성합니다.
3. 모든 artifact를 포함한 GitHub Release를 생성합니다.
4. stable release이면 Homebrew formula를 자동 갱신합니다.

### 3. Homebrew Formula 자동화

stable tag(`v0.1.0`처럼 `-`가 없는 tag)가 release되면 `release.yml`의 `update-homebrew` job이 자동으로 실행됩니다.

이 job은 다음을 처리합니다.
1. GitHub Release의 `checksums.txt`를 다운로드합니다.
2. `homebrew/hlab.rb`의 version, release URL, platform별 SHA256을 갱신합니다.
3. 갱신 commit을 `dev`에 push합니다.
4. repository variable `HOMEBREW_TAP_REPO`가 있으면 외부 tap repository에도 formula를 복사합니다.

외부 Homebrew tap까지 자동화하려면 repository settings에 다음을 설정합니다.

- Variable `HOMEBREW_TAP_REPO`: 예: `NewTurn2017/homebrew-harneeslab`
- Secret `HOMEBREW_TAP_TOKEN`: 해당 tap repo에 push 가능한 GitHub token
- Variable `HOMEBREW_TAP_FORMULA_PATH` optional: 기본값은 `Formula/hlab.rb`

### 4. 릴리스 검증

```bash
# Test the install script (only works if repo is public)
curl -fsSL https://raw.githubusercontent.com/NewTurn2017/HarneesLab/dev/scripts/install.sh | bash

# Verify version
hlab version
```

> **참고: Private Repository 설치**
>
> repository가 private이면 anonymous user에게는 curl install script가 동작하지 않습니다.
> 대신 GitHub CLI를 사용하세요.
>
> ```bash
> # Download and install using gh (requires GitHub authentication)
> gh release download v0.1.0 --repo NewTurn2017/HarneesLab \
>   --pattern "archon-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" \
>   --dir /tmp/archon-install
>
> # Install the binary
> chmod +x /tmp/archon-install/archon-*
> sudo mv /tmp/archon-install/archon-* /usr/local/bin/archon
>
> # Verify
> hlab version
> ```

## Manual Release (GitHub Actions를 사용할 수 없을 때)

GitHub Actions를 실행할 수 없다면(billing issue, private repo limit 등), release를 수동으로 만듭니다.

```bash
# 1. Build binaries locally (only builds for your current platform)
./scripts/build-binaries.sh

# 2. Create the release with binaries
gh release create vX.Y.Z dist/binaries/* \
  --title "HarneesLab CLI vX.Y.Z" \
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
# Create a pre-release tag through the version helper
bun run version:harneeslab -- set 0.2.0-beta.1
git add package.json packages/*/package.json
git commit -m "chore: release v0.2.0-beta.1"
git tag v0.2.0-beta.1
git push origin dev v0.2.0-beta.1
```

Pre-release(`-`가 포함된 tag)는 GitHub에서 pre-release로 표시됩니다.

## Hotfix 절차

이미 release된 버전에 긴급 fix가 필요하면:

```bash
# Create hotfix branch from tag
git checkout -b hotfix/0.1.1 v0.1.0

# Make fixes, then tag
git tag v0.1.1
git push origin v0.1.1

# Merge fixes back to dev
git checkout dev
git merge hotfix/0.1.1
git push origin dev
```
