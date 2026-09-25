// `bun test` preload: tests never send telemetry. Bun reads bunfig.toml only
// from the cwd, so the repo root and every package with tests preload this file
// (enforced by scripts/bun-test-command.test.ts); the runners also pass it via
// bunTestEnv. A test that covers telemetry re-enables it in its own child env.
process.env.ARCHON_TELEMETRY_DISABLED ??= '1';
