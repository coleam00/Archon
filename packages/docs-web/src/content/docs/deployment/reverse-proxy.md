---
title: Running Archon behind your own reverse proxy
description: The routing, authentication, webhook, and streaming contract for an Archon reverse proxy.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 4
---

You can use your own reverse proxy if it satisfies the contract below. Caddy is Archon's single maintained reference proxy: start with [Caddyfile.example](https://github.com/coleam00/Archon/blob/dev/Caddyfile.example) and the [Cloud deployment guide](/deployment/cloud/). Other proxies are community examples, not supported Compose profiles.

## Upstream and route contract

Forward to Archon's **configured app port** (`PORT`), preserving the request path. Docker defaults to **3000**; local development defaults to **3090** (worktrees may allocate another port). See [Port configuration](/deployment/local/#port-configuration). Serve the UI and API at the same public origin.

Keep the upstream private so clients cannot bypass the proxy. For a proxy on the same host, use `HOST=127.0.0.1`. A container proxy needs a reachable container interface, but the app's host port must not be exposed publicly. The base Compose file publishes the app port; follow the [GitHub App Docker setup](/adapters/github-app-setup/#canonical-docker-setup) to replace that mapping with a loopback-only mapping.

| Route group | Proxy behavior |
| --- | --- |
| `/internal/*` | **Never forward**, for any HTTP method. Return a proxy-generated 404 or 403. |
| `GET /api/health` | Forward without interactive authentication for load-balancer and uptime checks. This is the Docker/production health endpoint. |
| `/webhooks/*` | Forward without interactive authentication. Preserve the raw body and the provider's signature, secret, event, and delivery headers. |
| `/api/stream/*` | Forward with response buffering off and timeouts that allow long-lived SSE connections. Apply the same access boundary as other protected API routes. |
| `/api/auth/*` | Forward login/session requests and cookies to Archon when using web auth; do not put them behind a proxy login that prevents users reaching Archon's login. |
| Other `/api/*`, UI pages, and assets | Forward normally, with the authentication posture described below. |

`/health` is also registered by the server and used as a local-development convenience endpoint. Use **`/api/health`** for production checks, matching Docker and the Caddy reference.

### Internal credentials: deny before forwarding

In GitHub App mode, `POST /internal/git-credential` hands out live installation tokens. It is registered only when the GitHub adapter is in App mode. The server refuses a non-loopback bind in App mode unless `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1` explicitly acknowledges it. **That flag does not protect the endpoint.** Set it only when the topology requires a non-loopback upstream, the upstream is private, and the proxy already denies `/internal/*`.

The Caddy reference denies `/internal/*` with a proxy-generated 404 before its catch-all forwards other paths. **Keep that denial in your deployed configuration.** Follow [Internal endpoint security](/adapters/github-app-setup/#internal-endpoint-security--required) for the Docker port restrictions and external **POST** probe, too. A GET returning 404 does not prove that the credential endpoint is blocked.

### Webhooks: preserve the signed payload

Archon reads webhook bodies as raw text before verification. Do not parse and reserialize JSON, rewrite the body, or strip verification headers. Proxy login pages and redirects must not intercept webhook deliveries; the configured adapter or webhook source verifies them. Preserve the original `/webhooks/...` path.

### Live streams: flush each event

Both the dashboard stream (`/api/stream/__dashboard__`) and conversation streams (`/api/stream/:conversationId`) send an initial heartbeat and another every **30 seconds**. Disable response buffering and caching for these routes. Set any idle/read timeout in the proxy chain above 30 seconds with margin, for example 60 seconds or longer, and avoid a fixed response-duration limit that cuts off a healthy stream.

The Caddy reference uses `flush_interval -1` for `/api/stream/*`. Verify events arrive as they are emitted, rather than appearing in a batch when the connection closes.

## Authentication and headers

With [Web UI login](/reference/configuration/#web-ui-login-better-auth-optional) enabled (`DATABASE_URL` and `BETTER_AUTH_SECRET`), Better Auth handles sessions and Archon's server-side gate protects `/api/*`. The gate is on by default; `ARCHON_WEB_AUTH_REQUIRED=false` disables it and leaves login as a UI feature only. `/api/auth/*` and `/api/health*` are public exceptions. Static UI files can be served without proxy authentication; the API gate is the access boundary.

The proxy does not need its own login when that gate is enabled, but **it must strip client-supplied `X-Archon-User`** (or the name configured by `ARCHON_WEB_AUTH_HEADER`). Archon accepts this trusted identity header as a fallback even with Better Auth enabled; allowing clients to supply it bypasses the API gate. If you deliberately use proxy authentication and identity attribution, strip incoming values and set the header only from the authenticated identity. Keep the upstream reachable solely through that trusted boundary.

Without web auth, or with its API gate disabled, the proxy must provide the access boundary for a network-accessible UI and API. Use the authentication options in the [Cloud guide](/deployment/cloud/#optional-form-based-authentication), or your proxy's equivalent, while keeping health checks and webhooks reachable. A reverse proxy alone does not add authentication.

Archon's application code does not read `X-Forwarded-*` headers as an access or identity contract. For Better Auth behind a fixed-origin proxy, set **`BETTER_AUTH_URL=https://archon.example.com`** to the public origin instead of relying on the upstream HTTP URL. Preserve session cookies. `BETTER_AUTH_TRUSTED_ORIGINS` is for additional allowed origins, not a replacement for the public URL. See the [configuration reference](/reference/configuration/#web-ui-login-better-auth-optional) for signup policy and auth settings.

## Community example: Traefik labels

This **community example is not a supported profile**. It assumes Traefik v3 with the Docker provider, a `websecure` HTTPS entry point and TLS certificates already configured, and a shared Docker network named `archon-network`. It uses **Archon's web auth with the API gate enabled**, `BETTER_AUTH_URL` set to the public origin, and the default identity header. Add these labels to your app service; adjust the host, network, and port to your deployment.

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.docker.network=archon-network"
  - "traefik.http.routers.archon.rule=Host(`archon.example.com`) && !PathPrefix(`/internal`)"
  - "traefik.http.routers.archon.entrypoints=websecure"
  - "traefik.http.routers.archon.tls=true"
  - "traefik.http.routers.archon.service=archon"
  - "traefik.http.routers.archon.middlewares=archon-strip-identity"
  - "traefik.http.middlewares.archon-strip-identity.headers.customrequestheaders.X-Archon-User="
  - "traefik.http.services.archon.loadbalancer.server.port=3000"
  - "traefik.http.services.archon.loadbalancer.healthcheck.path=/api/health"
  - "traefik.http.services.archon.loadbalancer.responseforwarding.flushinterval=-1ms"
```

The [router rule](https://doc.traefik.io/traefik/reference/routing-configuration/http/routing/rules-and-priority/) excludes the entire `/internal` prefix. Ensure no other router or fallback forwards it to Archon. The [headers middleware](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/headers/) removes the identity header, and the [service flush setting](https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/service/) flushes responses immediately. Do not add a buffering middleware to the stream routes. Keep the HTTPS entry point's [`transport.respondingTimeouts.writeTimeout`](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/) at `0s` (no response-duration limit) for long-lived streams, and check any outer load balancer's idle timeout as well.

Keep the app port private as described above. For GitHub App mode, complete the internal-endpoint setup and POST probe before exposing the deployment. Verify `/api/health`, a real webhook delivery, an unauthenticated API request (401 with the gate enabled, including when a forged identity header is sent), and a live stream through the public proxy.
