# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in HarneesLab, please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

Instead, email **cole@dynamous.ai** or use [GitHub's private vulnerability reporting](https://github.com/NewTurn2017/HarneesLab/security/advisories/new).

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We'll acknowledge and respond as soon as possible.

## Scope

This policy covers the HarneesLab codebase, including:

- CLI binary
- Server and Web UI
- Platform adapters (Slack, Telegram, GitHub, Discord)
- Docker images published to GHCR

## Best Practices for Users

- Never commit API keys to your repository
- Use environment variables or `.env` files (which are gitignored)
- When deploying the server publicly, use the Caddy reverse proxy with authentication (see `deploy/docker-compose.yml`)
- Keep HarneesLab updated to the latest version
