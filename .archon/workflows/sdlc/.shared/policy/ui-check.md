# UI check policy

The SDLC pack's default rules for a reviewer running a project's app. A project's
`.archon/sdlc/policy/ui-check.md` adds to them and wins where the two conflict.

- Every data directory, database and config home the app reads is a fresh one under
  `$ARTIFACTS_DIR`, never a user's real data or a configured live database.
- The app binds an unused port and gets empty values for credentials that reach a live
  service.
- Stop only the processes you started, by the PIDs you recorded when you started them.
  Never stop processes by name or pattern (`taskkill /IM`, `pkill`, `killall`,
  `Stop-Process -Name`): every Archon run on the machine is itself a `bun` process, so
  `taskkill /IM bun.exe` ends all of them.

## Browser tool

- Drive the browser with `playwright-cli` when `command -v playwright-cli` finds it,
  otherwise with `agent-browser` when `command -v agent-browser` finds it (Archon's
  Docker image ships it, with Chromium). Use the tool's skill where skills are invoked
  that way (`$playwright-cli`, `$agent-browser`); otherwise read the tool's `--help`.
- Check once, before starting the app or installing anything. When neither command is
  found, the app cannot be exercised on this host: say so, and do what the prompt says
  for that case. Do not look for a browser tool or a skill file anywhere else, do not
  install one, and do not check again.
- Every `find` or `rg` stays inside the checkout or `$ARTIFACTS_DIR`, with a depth
  limit. A search of `/`, `~` or the whole disk can outlive the turn and stall the node
  until its idle timeout.
