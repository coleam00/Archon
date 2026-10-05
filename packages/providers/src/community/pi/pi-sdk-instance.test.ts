/**
 * Conformance test: `@archon/providers` and the Pi runtime load ONE pi-ai module
 * instance.
 *
 * The compiled-binary shims in `provider.ts` (`ensureBedrockProviderRegistered`,
 * `ensurePiOAuthFlowsRegistered`) write into module-level registries inside
 * pi-ai. Pi only sees them if pi-coding-agent and pi-agent-core resolve the same
 * pi-ai files that this package imports. Bun's isolated linker installs a second
 * pi-ai copy whenever a transitive peer resolves differently in the two
 * contexts. With pi-ai 1.0.0, `openai`'s optional `undici` peer did exactly
 * that: the hoisted `undici` (6.x, pinned by discord.js) versus
 * pi-coding-agent's own 8.x. The registrations then landed on a copy Pi never
 * reads, and OAuth credentials failed in the compiled binary with
 * `Cannot find module './openai-codex.js'`.
 *
 * The exact `undici` dependency in this package's `package.json` exists only to
 * match pi-coding-agent's pin and collapse that split. This test is what keeps
 * the two pins in agreement: when a Pi upgrade moves its `undici`, or any other
 * peer splits the instances, it fails here instead of in a released binary.
 */
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from 'bun:test';

const PI_AI = '@earendil-works/pi-ai';

function resolveReal(specifier: string, fromDir: string): string {
  return realpathSync(Bun.resolveSync(specifier, fromDir));
}

const ownPiAi = resolveReal(PI_AI, import.meta.dir);
const codingAgentDir = dirname(resolveReal('@earendil-works/pi-coding-agent', import.meta.dir));
const agentCoreDir = dirname(resolveReal('@earendil-works/pi-agent-core', codingAgentDir));

test('pi-coding-agent resolves the same pi-ai instance as @archon/providers', () => {
  expect(resolveReal(PI_AI, codingAgentDir)).toBe(ownPiAi);
});

test('pi-agent-core resolves the same pi-ai instance as @archon/providers', () => {
  expect(resolveReal(PI_AI, agentCoreDir)).toBe(ownPiAi);
});
