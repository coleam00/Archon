---
title: Sandbox Setup Guide
description: How to prepare resettable repositories for Archon curriculum exercises and workshops.
category: learning
audience: [operator, user]
status: current
sidebar:
  order: 14
---

Use disposable repositories for early Archon learning. A sandbox lets learners
practice workflows, worktrees, artifacts, approval gates, and pull-request
readiness without risking important code.

## Sandbox Requirements

A good sandbox has:

- An initial Git commit.
- One tiny source file.
- One tiny test or validation command.
- One intentionally small change request.
- No secrets.
- No production remotes.
- A reset path.

## Minimal JavaScript Sandbox

Create this sandbox for quick local exercises.

macOS, Linux, or WSL:

```bash
mkdir -p ~/archon-sandbox/src
cd ~/archon-sandbox
git init
cat > README.md <<'EOF'
# Archon Sandbox

This repository exists only for learning Archon.
EOF
cat > src/math.js <<'EOF'
export function add(a, b) {
  return a + b;
}
EOF
cat > src/math.test.js <<'EOF'
import { add } from './math.js';

if (add(2, 3) !== 5) {
  throw new Error('add should return the sum');
}

console.log('math tests passed');
EOF
cat > package.json <<'EOF'
{
  "type": "module",
  "scripts": {
    "test": "node src/math.test.js"
  }
}
EOF
git add .
git commit -m "Initial sandbox commit"
```

Windows PowerShell:

```powershell
mkdir $HOME\archon-sandbox
mkdir $HOME\archon-sandbox\src
cd $HOME\archon-sandbox
git init
"# Archon Sandbox`n`nThis repository exists only for learning Archon." | Set-Content README.md
"export function add(a, b) {`n  return a + b;`n}" | Set-Content src\math.js
"import { add } from './math.js';`n`nif (add(2, 3) !== 5) {`n  throw new Error('add should return the sum');`n}`n`nconsole.log('math tests passed');" | Set-Content src\math.test.js
'{"type":"module","scripts":{"test":"node src/math.test.js"}}' | Set-Content package.json
git add .
git commit -m "Initial sandbox commit"
```

Verify:

```bash
npm test
git status
```

Expected:

```text
math tests passed
working tree clean
```

## Prepared Change Request

Use this request for first implementation exercises:

```text
Add a subtract(a, b) function to src/math.js and update the test file to verify
subtract(5, 2) returns 3. Keep the module simple.
```

Expected validation:

```bash
npm test
```

## Prepared Failure Sandbox

Create a second repository or branch with a deliberate failing test.

```bash
cp -R ~/archon-sandbox ~/archon-sandbox-failing
cd ~/archon-sandbox-failing
git checkout -b prepared/failing-test
```

Edit `src/math.test.js` so it expects the wrong value:

```js
import { add } from './math.js';

if (add(2, 3) !== 6) {
  throw new Error('prepared failure: add should return 6');
}

console.log('math tests passed');
```

Commit it:

```bash
git add src/math.test.js
git commit -m "Prepare failing validation exercise"
```

Use this repository for [Troubleshooting Labs](/learning/troubleshooting-labs/).

## Optional GitHub Sandbox

For GitHub exercises:

1. Create a private or throwaway repository.
2. Push the sandbox.
3. Create one issue with the prepared change request.
4. Authenticate `gh` privately.
5. Confirm learners stop at PR review, not merge.

Do not use a production repository for the first GitHub capstone.

## Reset Instructions

For local-only sandboxes, reset by deleting and recreating the directory, or by
returning to the initial branch:

```bash
git status
git branch
git log --oneline -3
```

If the sandbox has no work you need to preserve, recreate it from the commands
above. Do not run destructive cleanup commands in a real repository.

## Facilitator Checklist

```text
Sandbox path:
Initial commit exists:
Test command works:
Prepared change request exists:
Prepared failure exists:
GitHub issue exists, if needed:
No secrets present:
Reset path tested:
Provider fallback tested:
```
