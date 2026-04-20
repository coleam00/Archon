---
title: Windows 설정
description: Windows에서 Bun으로 native 실행하거나 WSL2 호환 모드로 Archon을 실행합니다.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 4
---

Archon은 Windows에서 두 가지 방식으로 실행할 수 있습니다.

- **Bun을 사용한 native Windows**: 기본 사용(server, Web UI, 단순 workflow)에 동작합니다. WSL2는 필요하지 않습니다. [Bun for Windows](https://bun.sh)를 설치하고 repo를 clone한 뒤 `bun install && bun run dev`를 실행합니다.
- **WSL2(권장)**: 전체 호환성에 필요합니다. 특히 git worktree isolation, shell 기반 workflow step, Unix tool에 의존하는 CLI 기능에 필요합니다.

이 가이드의 나머지 부분은 전체 호환성을 위한 WSL2 setup을 다룹니다.

## Why WSL2?

Archon CLI는 Unix 전용 기능과 tool에 의존합니다.

- symlink를 사용하는 git worktree operation
- AI agent 실행을 위한 shell scripting
- Windows와 Unix에서 다르게 동작하는 file system operation

WSL2는 Windows에서 자연스럽게 실행되는 완전한 Linux environment를 제공합니다.

## 빠른 WSL2 설정

1. **WSL2 설치**(Windows 10 version 2004+ 또는 Windows 11 필요):
   ```powershell
   wsl --install
   ```
   기본적으로 Ubuntu가 설치됩니다. 안내가 나오면 컴퓨터를 재시작합니다.

2. **Ubuntu 설정**:
   Start menu에서 "Ubuntu"를 열고 username/password를 만듭니다.

3. **WSL2에 Bun 설치**:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   source ~/.bashrc
   ```

4. **Archon clone 및 설치**:
   ```bash
   git clone https://github.com/coleam00/Archon
   cd Archon
   bun install
   ```

5. **CLI를 전역에서 사용할 수 있게 설정**:
   ```bash
   cd packages/cli
   bun link
   ```

6. **설치 확인**:
   ```bash
   archon version
   ```

## Windows file로 작업하기

WSL2는 `/mnt/c/`에서 Windows file(C: drive)에 접근할 수 있습니다.
```bash
archon workflow run assist --cwd /mnt/c/Users/YourName/Projects/my-repo "What does this code do?"
```

성능을 위해서는 project를 `/mnt/c/`보다 WSL2 file system 안(`~/projects/`)에 두는 것이 좋습니다.

## 남아 있는 process(native Windows 전용)

:::note
이 섹션은 native Windows(PowerShell 또는 CMD에서 `bun run dev`)에 적용됩니다. WSL2를 사용한다면 대신 `pkill -f bun`을 사용하세요.
:::

**증상:** `bun run dev` 시작 후 Web UI가 응답 없이 spinning indicator만 보여주거나, 시작 시 `EADDRINUSE` error가 표시됩니다.

**원인:** 이전 `bun` 또는 `node` process가 여전히 port를 점유하고 있습니다. 보통 server를 중지하지 않고 terminal을 닫았을 때 발생합니다.

**진단:**

```powershell
netstat -ano | findstr :3090
```

마지막 column의 PID를 기록한 뒤 어떤 process인지 확인합니다.

```powershell
tasklist | findstr 12345
```

(`12345`를 `netstat`에서 확인한 실제 PID로 바꿉니다.)

**수정: PID로 종료**(권장):

```powershell
taskkill /F /PID 12345
```

남아 있는 process가 여러 개라면 다음을 실행합니다.

```powershell
taskkill /F /IM bun.exe
taskkill /F /IM node.exe
```

:::caution
`claude.exe` process는 종료하지 마세요. 활성 Claude Code session입니다.
:::

문제 해결 가이드의 [Port Conflicts](/reference/troubleshooting/#port-conflicts)도 참고하세요.

## 팁

- **VS Code Integration**: VS Code에서 WSL2 file을 편집하려면 "Remote - WSL" extension을 설치합니다.
- **Terminal**: Windows Terminal은 WSL2 지원이 좋습니다.
- **Git**: Archon과 일관된 동작을 위해 WSL2 안에서 Git을 사용합니다.
