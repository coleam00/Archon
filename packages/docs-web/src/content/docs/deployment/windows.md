---
title: Windows Setup
description: Run Archon on Windows natively with Bun or with full WSL2 compatibility.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 4
---

Archon runs on Windows in two ways:

- **Native Windows with Bun**: Works for basic usage (server, Web UI, simple workflows). No WSL2 required. Install [Bun for Windows](https://bun.sh), clone the repo, and run `bun install && bun run dev`.
- **WSL2 (recommended)**: Required for full compatibility, especially git worktree isolation, shell-based workflow steps, and CLI features that depend on Unix tooling.

The rest of this guide covers the WSL2 setup for full compatibility.

## Why WSL2?

The Archon CLI relies on Unix-specific features and tools:
- Git worktree operations with symlinks
- Shell scripting for AI agent execution
- File system operations that differ between Windows and Unix

WSL2 provides a full Linux environment that runs seamlessly on Windows.

## Quick WSL2 Setup

1. **Install WSL2** (requires Windows 10 version 2004+ or Windows 11):
   ```powershell
   wsl --install
   ```
   This installs Ubuntu by default. Restart your computer when prompted.

2. **Set up Ubuntu**:
   Open "Ubuntu" from the Start menu and create a username/password.

3. **Install Bun in WSL2**:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   source ~/.bashrc
   ```

4. **Clone and install Archon**:
   ```bash
   git clone https://github.com/coleam00/Archon
   cd Archon
   bun install
   ```

5. **Make CLI globally available**:
   ```bash
   cd packages/cli
   bun link
   ```

6. **Verify installation**:
   ```bash
   archon version
   ```

## Working with Windows Files

WSL2 can access your Windows files at `/mnt/c/` (for C: drive):
```bash
archon workflow run assist --cwd /mnt/c/Users/YourName/Projects/my-repo "What does this code do?"
```

For best performance, keep projects inside the WSL2 file system (`~/projects/`) rather than `/mnt/c/`.

## Stale Processes (Native Windows Only)

:::note
This section applies to native Windows (`bun run dev` in PowerShell or CMD). If you're using WSL2, use `pkill -f bun` instead.
:::

**Symptom:** The Web UI shows a spinning indicator with no response after starting `bun run dev`, or you see `EADDRINUSE` errors on startup.

**Cause:** A previous `bun` or `node` process is still holding the port, typically because the terminal was closed without stopping the server.

**Diagnose:**

```powershell
netstat -ano | findstr :3090
```

Note the PID in the last column, then confirm which process it is:

```powershell
tasklist | findstr 12345
```

(Replace `12345` with the actual PID from `netstat`.)

**Fix — kill by PID** (preferred):

```powershell
taskkill /F /PID 12345
```

If there are multiple stale processes:

```powershell
taskkill /F /IM bun.exe
taskkill /F /IM node.exe
```

:::caution
Do not kill `claude.exe` processes — those are active Claude Code sessions.
:::

See also: [Port Conflicts](/reference/troubleshooting/#port-conflicts) in the troubleshooting guide.

## Tips

- **VS Code Integration**: Install the "Remote - WSL" extension to edit WSL2 files from VS Code
- **Terminal**: Windows Terminal provides excellent WSL2 support
- **Git**: Use Git inside WSL2 for consistent behavior with Archon
