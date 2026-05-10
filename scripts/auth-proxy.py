#!/usr/bin/env python3
"""
Minimal HTTP basic-auth reverse proxy.

Listens on 127.0.0.1:9999, requires basic auth, forwards everything (incl.
WebSockets used by Vite HMR) to 127.0.0.1:5173.

Credentials:
  - Username: read from env AUTH_USER (default: pmc)
  - Password: read from env AUTH_PASS (REQUIRED, no default)

Run:
  AUTH_USER=pmc AUTH_PASS='...' python3 scripts/auth-proxy.py

Logs to stdout. Stop with SIGTERM.
"""

import asyncio
import base64
import os
import sys
from http import HTTPStatus

UPSTREAM_HOST = os.environ.get("UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("UPSTREAM_PORT", "5173"))
LISTEN_HOST = os.environ.get("LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "9999"))

AUTH_USER = os.environ.get("AUTH_USER", "pmc")
AUTH_PASS = os.environ.get("AUTH_PASS")

if not AUTH_PASS:
    print("FATAL: AUTH_PASS env var is required", file=sys.stderr)
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
