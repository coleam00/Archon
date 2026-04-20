[Skip to content](https://archon.diy/deployment/#_top)

[Archon](https://archon.diy/)

Search `CtrlK`

Cancel

Clear

[GitHub](https://github.com/coleam00/Archon)

Select themeDarkLightAuto

- The Book of Archon
  - [The Book of Archon](https://archon.diy/book/)
  - [What Is Archon?](https://archon.diy/book/what-is-archon/)
  - [Your First Five Minutes](https://archon.diy/book/first-five-minutes/)
  - [How Archon Actually Works](https://archon.diy/book/how-it-works/)
  - [The Essential Workflows](https://archon.diy/book/essential-workflows/)
  - [Isolation and Worktrees](https://archon.diy/book/isolation/)
  - [Creating Your First Command](https://archon.diy/book/first-command/)
  - [Creating Your First Workflow](https://archon.diy/book/first-workflow/)
  - [DAG Workflows](https://archon.diy/book/dag-workflows/)
  - [Hooks and Quality Loops](https://archon.diy/book/hooks-and-quality/)
  - [Quick Reference](https://archon.diy/book/quick-reference/)

- Getting Started
  - [Installation](https://archon.diy/getting-started/installation/)
  - [Getting Started](https://archon.diy/getting-started/overview/)
  - [Core Concepts](https://archon.diy/getting-started/concepts/)
  - [Quick Start](https://archon.diy/getting-started/quick-start/)
  - [Configuration](https://archon.diy/getting-started/configuration/)
  - [AI Assistants](https://archon.diy/getting-started/ai-assistants/)

- Guides
  - [Guides](https://archon.diy/guides/)
  - [Authoring Workflows](https://archon.diy/guides/authoring-workflows/)
  - [Authoring Commands](https://archon.diy/guides/authoring-commands/)
  - [Loop Nodes](https://archon.diy/guides/loop-nodes/)
  - [Approval Nodes](https://archon.diy/guides/approval-nodes/)
  - [Per-Node Hooks](https://archon.diy/guides/hooks/)
  - [Per-Node MCP Servers](https://archon.diy/guides/mcp-servers/)
  - [Per-Node Skills](https://archon.diy/guides/skills/)
  - [Global Workflows](https://archon.diy/guides/global-workflows/)
  - [Remotion Video Generation Workflow](https://archon.diy/guides/remotion-workflow/)

- Adapters
  - [Platform Adapters](https://archon.diy/adapters/)
  - [Web UI](https://archon.diy/adapters/web/)
  - [Slack](https://archon.diy/adapters/slack/)
  - [Telegram](https://archon.diy/adapters/telegram/)
  - [GitHub](https://archon.diy/adapters/github/)
  - community
    - [Discord](https://archon.diy/adapters/community/discord/)
    - [Gitea](https://archon.diy/adapters/community/gitea/)
    - [GitLab](https://archon.diy/adapters/community/gitlab/)

- Deployment
  - [Deployment Overview](https://archon.diy/deployment/)
  - [Local Development](https://archon.diy/deployment/local/)
  - [Docker Guide](https://archon.diy/deployment/docker/)
  - [Cloud Deployment](https://archon.diy/deployment/cloud/)
  - [Windows Setup](https://archon.diy/deployment/windows/)
  - [E2E Testing](https://archon.diy/deployment/e2e-testing/)
  - [E2E Testing on WSL](https://archon.diy/deployment/e2e-testing-wsl/)

- Reference
  - [Reference](https://archon.diy/reference/)
  - [Architecture](https://archon.diy/reference/architecture/)
  - [Archon Directories](https://archon.diy/reference/archon-directories/)
  - [CLI Reference](https://archon.diy/reference/cli/)
  - [Commands Reference](https://archon.diy/reference/commands/)
  - [Database](https://archon.diy/reference/database/)
  - [Variable Reference](https://archon.diy/reference/variables/)
  - [API Reference](https://archon.diy/reference/api/)
  - [Configuration Reference](https://archon.diy/reference/configuration/)
  - [Troubleshooting](https://archon.diy/reference/troubleshooting/)
  - [Security](https://archon.diy/reference/security/)

- Contributing
  - [Contributing](https://archon.diy/contributing/)
  - [New Developer Guide](https://archon.diy/contributing/new-developer-guide/)
  - [CLI Internals](https://archon.diy/contributing/cli-internals/)
  - [Releasing](https://archon.diy/contributing/releasing/)
  - [DX Quirks](https://archon.diy/contributing/dx-quirks/)

[GitHub](https://github.com/coleam00/Archon)

Select themeDarkLightAuto

On this page

- [Overview](https://archon.diy/deployment/#_top)
- [Deployment Options](https://archon.diy/deployment/#deployment-options)
- [Database Options](https://archon.diy/deployment/#database-options)
- [Testing](https://archon.diy/deployment/#testing)

## On this page

- [Overview](https://archon.diy/deployment/#_top)
- [Deployment Options](https://archon.diy/deployment/#deployment-options)
- [Database Options](https://archon.diy/deployment/#database-options)
- [Testing](https://archon.diy/deployment/#testing)

# Deployment Overview

Archon can run locally for development or be deployed to a server for always-on operation.

## Deployment Options

[Section titled “Deployment Options”](https://archon.diy/deployment/#deployment-options)

| Method        | Best For                             | Guide                                                     |
| ------------- | ------------------------------------ | --------------------------------------------------------- |
| **Local**     | Development, personal use            | [Local Development](https://archon.diy/deployment/local/) |
| **Docker**    | Self-hosted servers, CI environments | [Docker](https://archon.diy/deployment/docker/)           |
| **Cloud VPS** | 24/7 operation with automatic HTTPS  | [Cloud Deployment](https://archon.diy/deployment/cloud/)  |
| **Windows**   | Native Windows or WSL2               | [Windows](https://archon.diy/deployment/windows/)         |

## Database Options

[Section titled “Database Options”](https://archon.diy/deployment/#database-options)

| Option                | Setup                                 | Best For                                  |
| --------------------- | ------------------------------------- | ----------------------------------------- |
| **SQLite** (default)  | Zero config, just omit `DATABASE_URL` | Single-user, CLI usage, local development |
| **Remote PostgreSQL** | Set `DATABASE_URL` to hosted DB       | Cloud deployments, shared access          |
| **Local PostgreSQL**  | Docker `--profile with-db`            | Self-hosted, Docker-based setups          |

SQLite stores data at `~/.archon/archon.db` (or `/.archon/archon.db` in Docker). It is auto-initialized on first run.

## Testing

[Section titled “Testing”](https://archon.diy/deployment/#testing)

| Guide                                                                | Audience                 |
| -------------------------------------------------------------------- | ------------------------ |
| [E2E Testing](https://archon.diy/deployment/e2e-testing/)            | Developers and operators |
| [E2E Testing on WSL](https://archon.diy/deployment/e2e-testing-wsl/) | Developers on Windows    |

[Edit page](https://github.com/coleam00/Archon/edit/main/packages/docs-web/src/content/docs/deployment/index.md)

[Previous \\
\\
GitLab](https://archon.diy/adapters/community/gitlab/) [Next \\
\\
Local Development](https://archon.diy/deployment/local/)
