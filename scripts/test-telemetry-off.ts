// Root `bun test` preload: tests never send telemetry (see bunTestEnv in
// bun-test-command.ts, which covers the package runners). Package directories
// read their own bunfig.toml, so this only covers runs started from the root.
process.env.ARCHON_TELEMETRY_DISABLED ??= '1';
