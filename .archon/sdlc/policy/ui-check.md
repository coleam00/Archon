# UI check policy

Archon's additions to the SDLC pack's default UI check policy. The reviewer reads the
default first and this file after it.

- The console is the Web UI the server serves at `/`. In the scratch worktree, run
  `bun install --frozen-lockfile` and `bun run build:web`, then start the server with
  `ARCHON_HOME=<fresh dir under $ARTIFACTS_DIR> PORT=<unused port> bun run start`
  and open `http://localhost:<port>/`.
- Never point `ARCHON_HOME` at `~/.archon` or copy `~/.archon/archon.db`: it holds
  credentials, and a server booted on a copy removes the real worktrees and resumes
  the paused runs it records. Seed what a flow needs through the server's own API or
  the CLI run with the same `ARCHON_HOME`.
- Pass `DATABASE_URL` as `''`: when set, the server uses that database instead of
  the SQLite file under `ARCHON_HOME`.
- Pass `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`,
  `GH_TOKEN`, `GITHUB_TOKEN` and `WEBHOOK_SECRET` as `''` so no adapter connects to a
  live service.
