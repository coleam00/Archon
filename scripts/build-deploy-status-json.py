#!/usr/bin/env python3
"""Capture deploy-chain status for the dashboard footer.

Emits a tiny JSON the static dashboard renders in its footer so Jason has live
deploy proof. Per Greg Queue B 2026-06-11 D3: confirm Caddy chain, surface
`tailscale funnel status` in the footer.

Chain (canonical): gregs-mac-mini.tail4e0ac6.ts.net:443
                     → :8401 (Caddy: jid5274-hermes-expose)
                     → :9999 (Python auth-proxy)
                     → :5173 (Vite static-build dev server)

Output: packages/web/src/lib/deploy-status.generated.json

The output is intentionally small (one object, ~ 20 lines) so the footer line
loads instantly and stays readable even when offline.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ARCHON_ROOT = SCRIPT_DIR.parent
OUT_PATH = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "deploy-status.generated.json"

CADDY_CHAIN = [
    {"hop": "gregs-mac-mini.tail4e0ac6.ts.net:443", "role": "Tailscale Funnel public ingress"},
    {"hop": ":8401", "role": "Caddy (jid5274-hermes-expose)"},
    {"hop": ":9999", "role": "Python auth-proxy"},
    {"hop": ":5173", "role": "Vite static dashboard"},
]


def funnel_status() -> dict[str, str]:
    """Best-effort `tailscale funnel status` capture. Returns {} on miss."""
    bin_path = shutil.which("tailscale")
    if not bin_path:
        return {"available": "false", "reason": "tailscale CLI not on PATH"}
    try:
        result = subprocess.run(
            [bin_path, "funnel", "status"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        output = (result.stdout or result.stderr or "").strip()
        # Compact: first non-empty line + the count of additional lines.
        lines = [ln for ln in output.splitlines() if ln.strip()]
        first = lines[0] if lines else "(no output)"
        return {
            "available": "true",
            "exit_code": str(result.returncode),
            "first_line": first[:160],
            "line_count": str(len(lines)),
        }
    except subprocess.TimeoutExpired:
        return {"available": "false", "reason": "tailscale funnel status timed out (5s)"}
    except Exception as exc:  # noqa: BLE001 — diagnostic only, must not crash build
        return {"available": "false", "reason": f"error: {exc!r}"[:200]}


def main() -> int:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "chain": CADDY_CHAIN,
        "canonical_url": "https://gregs-mac-mini.tail4e0ac6.ts.net/",
        "doc": "second-brain/intelligence/decisions/2026-06-12-caddy-tailscale-funnel-chain.md",
        "funnel_status": funnel_status(),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"[build-deploy-status] wrote {OUT_PATH.relative_to(ARCHON_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
