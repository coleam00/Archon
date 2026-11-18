Hold a change to this project's own documents: `.archon/engineering.md` and `.archon/architecture.md`.

Anything that runs Archon itself (the CLI, a server, a test that opens a database) uses a scratch home: set `ARCHON_HOME` to a new empty directory first, and remove it afterwards. Archon migrates a database when it opens one, so running this checkout against the real home changes the operator's live database.
