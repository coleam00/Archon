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
