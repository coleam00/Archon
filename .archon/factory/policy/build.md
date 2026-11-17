Hold the code of a change to this project's own documents: `.archon/engineering.md` and `.archon/architecture.md`.

Anything that runs Archon itself (the CLI, a server, a test that opens a database) uses a scratch home: set `ARCHON_HOME` to a new empty directory first, and remove it afterwards. Archon migrates a database when it opens one, so running this checkout against the real home changes the operator's live database.

- A new test file must be listed in its package's `testGroups` in `package.json`, or the package runner refuses it and CI's test inventory fails. After adding a test file, run it through the package's own test script and run `bun test scripts/test-inventory.test.ts`.

- A new or changed API route needs its row in the API reference page; `packages/docs-web` has tests that compare the generated API with the reference. Run the docs-web test script when you touch a route.

- A generated file is changed through its generator, never by hand: the API types, the node-execution reference, the capability matrix and the other pages a `generate:*` script in the root `package.json` writes. After touching a generator, its source, or such a file, run the matching `check:*` script and say that it passed. CI refuses a stale generated file.
