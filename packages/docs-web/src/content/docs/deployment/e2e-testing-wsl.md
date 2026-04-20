---
title: WSL에서 E2E Testing
description: dev server가 Windows에서 실행될 때 end-to-end testing을 위해 WSL 안에서 agent-browser를 실행합니다.
category: deployment
area: infra
audience: [developer]
status: current
sidebar:
  order: 6
---

Vercel의 `agent-browser`에는 Unix domain socket 비호환성 때문에 daemon 시작에 실패하는 [known Windows bug](https://github.com/vercel-labs/agent-browser/issues/56)가 있습니다. workaround는 dev server는 Windows에서 실행하고 agent-browser는 WSL 안에서 실행하는 것입니다.

> **일반 setup:** WSL이 아닌 플랫폼(macOS, Linux, Docker)은 대신 [E2E Testing 가이드](/deployment/e2e-testing/)를 참고하세요.

## 사전 준비

- Ubuntu가 설치된 WSL2(`wsl --list --verbose`)
- WSL 안에 설치된 agent-browser: `npm install -g agent-browser`
- 설치된 Playwright chromium: `agent-browser install --with-deps`(sudo 필요)

## 설정

### 1. WSL에서 접근 가능한 Windows host IP 찾기

```bash
ipconfig | findstr "IPv4" | findstr "WSL"
# Example output: IPv4 Address. . . . . . . . . . . : 172.18.64.1
```

또는 WSL 안에서 다음을 실행합니다.
```bash
wsl -d Ubuntu -- bash -c "cat /etc/resolv.conf | grep nameserver"
```

이 시스템의 Windows host IP는 `172.18.64.1`입니다.

### 2. Windows에서 dev server 시작(모든 interface에 bind)

```bash
# Backend (Hono on port 3090) - already binds to 0.0.0.0 by default
bun run dev:server &

# Frontend (Vite on port 5173) - needs --host flag
cd packages/web && bun x vite --host 0.0.0.0 &
```

### 3. WSL에서 server에 접근 가능한지 확인

```bash
wsl -d Ubuntu -- curl -s http://172.18.64.1:3090/api/health
wsl -d Ubuntu -- curl -s -o /dev/null -w "%{http_code}" http://172.18.64.1:5173
```

## agent-browser command 실행

모든 command는 Windows terminal에서 실행하며 앞에 `wsl -d Ubuntu --`를 붙입니다.

```bash
# Open a page
wsl -d Ubuntu -- agent-browser open http://172.18.64.1:5173

# Take interactive snapshot (get element refs like @e1, @e2)
wsl -d Ubuntu -- agent-browser snapshot -i

# Click, fill, press
wsl -d Ubuntu -- agent-browser click @e1
wsl -d Ubuntu -- agent-browser fill @e2 "some text"
wsl -d Ubuntu -- agent-browser press Enter

# Wait for content to load
wsl -d Ubuntu -- agent-browser wait 3000

# Reload page (hard refresh)
wsl -d Ubuntu -- agent-browser reload

# Close browser
wsl -d Ubuntu -- agent-browser close
```

## screenshot 찍기

Screenshot은 먼저 WSL-native path에 저장한 뒤, `/mnt/c/` mount를 통해 Windows filesystem으로 복사해야 합니다.

```bash
# Save to WSL home, then copy to project
wsl -d Ubuntu -- bash -c '
  agent-browser screenshot /home/user/screenshot.png 2>&1 &&
  cp /home/user/screenshot.png /path/to/archon/e2e-screenshots/my-test.png
'
```

**왜 `/mnt/c/...`에 직접 저장하지 않나요?** agent-browser는 Node.js process를 통해 path를 resolve하는데, 일부 setup에서는 `/mnt/c/` path가 깨질 수 있습니다(예: `C:/Program Files/Git/`가 앞에 붙음). WSL-native path에 저장한 뒤 복사하면 이를 피할 수 있습니다.

## 주의할 점

- **WSL2에서 `localhost`는 동작하지 않습니다** - Windows host IP(`172.18.64.1`)를 사용해야 합니다.
- **Vite는 `0.0.0.0`에 bind해야 합니다** - 기본 `localhost`는 WSL에서 접근할 수 없습니다.
- **Git Bash path expansion** - Git Bash를 거치면 `/status`가 `C:/Program Files/Git/status`로 확장됩니다. agent-browser 문제가 아니라 shell이 `/` path를 확장하는 문제입니다.
- **SSE `Connected` indicator** - `web` platform conversation에서만 표시됩니다. Telegram/Slack conversation은 `Disconnected`로 표시됩니다(예상 동작).
- **Daemon startup** - `agent-browser open`이 "Daemon failed to start"로 실패하면 stale daemon을 종료하고 다시 시도합니다: `wsl -d Ubuntu -- pkill -f daemon.js`
