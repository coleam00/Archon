#!/usr/bin/env python3
"""
Minimal HTTP basic-auth reverse proxy.

Listens on 127.0.0.1:9999, requires basic auth, forwards everything (incl.
WebSockets used by Vite HMR) to 127.0.0.1:5173.

Credentials (resolved in order):
  1. AUTH_USER + AUTH_PASS env vars (highest priority)
  2. ~/.hermes/secrets/jid5274/auth-proxy.env (KEY=value lines, chmod 600)

This dual path lets `python3 scripts/auth-proxy.py` work both interactively
(env override) and under launchd (env file fallback — plists are world-
readable, so creds must NOT live in the plist).

Run interactively:
  AUTH_USER=pmc AUTH_PASS='...' python3 scripts/auth-proxy.py

Run under launchd:
  Ensure ~/.hermes/secrets/jid5274/auth-proxy.env exists with:
    AUTH_USER=pmc
    AUTH_PASS=<password>
  Then launchctl load ~/Library/LaunchAgents/com.jid5274.auth-proxy.plist

Logs to stdout. Stop with SIGTERM.
"""

import asyncio
import base64
import os
import sys
from http import HTTPStatus
from pathlib import Path
from typing import Dict, Optional


def _load_env_file(path: Path) -> Dict[str, str]:
    """Parse a simple KEY=value .env file. Ignores blank lines and # comments.
    Strips matching surrounding single/double quotes from the value."""
    out: Dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        out[key] = value
    return out


_ENV_FILE = Path.home() / ".hermes" / "secrets" / "jid5274" / "auth-proxy.env"
_ENV_FROM_FILE = _load_env_file(_ENV_FILE)


def _resolve(key: str, default: Optional[str] = None) -> Optional[str]:
    """env var > .env file > default."""
    if key in os.environ:
        return os.environ[key]
    if key in _ENV_FROM_FILE:
        return _ENV_FROM_FILE[key]
    return default


UPSTREAM_HOST = _resolve("UPSTREAM_HOST", "127.0.0.1") or "127.0.0.1"
UPSTREAM_PORT = int(_resolve("UPSTREAM_PORT", "5173") or "5173")
LISTEN_HOST = _resolve("LISTEN_HOST", "127.0.0.1") or "127.0.0.1"
LISTEN_PORT = int(_resolve("LISTEN_PORT", "9999") or "9999")

AUTH_USER = _resolve("AUTH_USER", "pmc") or "pmc"
AUTH_PASS = _resolve("AUTH_PASS")

if not AUTH_PASS:
    print(
        f"FATAL: AUTH_PASS not set in env nor in {_ENV_FILE}",
        file=sys.stderr,
    )
    sys.exit(1)

EXPECTED_AUTH = b"Basic " + base64.b64encode(
    f"{AUTH_USER}:{AUTH_PASS}".encode()
)

UNAUTH_RESPONSE = (
    b"HTTP/1.1 401 Unauthorized\r\n"
    b'WWW-Authenticate: Basic realm="PMC Dashboard"\r\n'
    b"Content-Length: 12\r\n"
    b"Connection: close\r\n"
    b"\r\n"
    b"Unauthorized"
)


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_client(client_reader, client_writer):
    peer = client_writer.get_extra_info("peername")
    try:
        # Read request line + headers
        header_buf = b""
        while b"\r\n\r\n" not in header_buf:
            chunk = await client_reader.read(4096)
            if not chunk:
                client_writer.close()
                return
            header_buf += chunk
            if len(header_buf) > 64 * 1024:
                client_writer.close()
                return

        head, _, rest = header_buf.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        if not lines:
            client_writer.close()
            return

        # Find Authorization header
        auth_value = None
        for line in lines[1:]:
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"authorization":
                auth_value = value.strip()
                break

        if auth_value != EXPECTED_AUTH:
            print(f"[auth-proxy] 401 from {peer}", flush=True)
            client_writer.write(UNAUTH_RESPONSE)
            await client_writer.drain()
            client_writer.close()
            return

        # Strip Authorization header before forwarding (don't leak creds upstream)
        filtered_lines = [lines[0]]
        for line in lines[1:]:
            name = line.split(b":", 1)[0].strip().lower()
            if name == b"authorization":
                continue
            filtered_lines.append(line)
        forwarded_head = b"\r\n".join(filtered_lines) + b"\r\n\r\n"

        # Connect upstream
        try:
            up_reader, up_writer = await asyncio.open_connection(
                UPSTREAM_HOST, UPSTREAM_PORT
            )
        except Exception as e:
            print(f"[auth-proxy] upstream connect failed: {e}", flush=True)
            client_writer.write(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 11\r\n"
                b"Connection: close\r\n\r\nBad Gateway"
            )
            await client_writer.drain()
            client_writer.close()
            return

        # Forward the request head + any leftover body bytes
        up_writer.write(forwarded_head + rest)
        await up_writer.drain()

        # Pipe both directions concurrently (handles WebSocket upgrades)
        await asyncio.gather(
            pipe(client_reader, up_writer),
            pipe(up_reader, client_writer),
            return_exceptions=True,
        )

    except Exception as e:
        print(f"[auth-proxy] handler error: {e}", flush=True)
        try:
            client_writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
    print(
        f"[auth-proxy] listening on {addrs} -> {UPSTREAM_HOST}:{UPSTREAM_PORT} "
        f"(user={AUTH_USER})",
        flush=True,
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
