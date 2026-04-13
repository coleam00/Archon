# Cloudflare Quick Tunnel

Expose the Archon web UI to the internet (phone, remote access, webhooks) without port forwarding.

## Prerequisites

- Archon running locally (`bun run dev`)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed

## Quick start

```bash
# Install cloudflared (Windows)
winget install --id Cloudflare.cloudflared

# Start Archon (both server + frontend)
bun run dev

# In a separate terminal — expose the frontend
cloudflared tunnel --url http://localhost:5173
```

The tunnel URL (e.g. `https://random-name.trycloudflare.com`) is printed in the cloudflared output.

## Important notes

- **URL changes** on every cloudflared restart — not suitable for permanent webhooks
- **Frontend port is 5173** (Vite). Do not tunnel port 3090 (backend API only)
- The Vite config has `host: true` and `allowedHosts: true` — no extra config needed
- Quick Tunnel URLs are free, no Cloudflare account needed
- For a permanent URL, use a [Named Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) with a free Cloudflare account

## SSE / real-time streaming

The frontend proxies API calls (`/api/*`, `/api/stream/*`) to the backend via Vite's dev proxy. SSE streaming works through the tunnel without additional configuration.
