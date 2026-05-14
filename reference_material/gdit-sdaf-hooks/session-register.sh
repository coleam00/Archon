#!/usr/bin/env bash
# Hook: SessionStart — auto-register session and configure knowledge settings
# Exit: always 0 (never blocks)

python3 ~/.kiro/scripts/session-lock.py auto-register --spec session 2>/dev/null || true
python3 ~/.kiro/scripts/knowledge-init.py --configure-only --project-dir "$PWD" 2>/dev/null || true
exit 0
