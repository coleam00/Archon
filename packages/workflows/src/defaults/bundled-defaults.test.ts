import { describe, it, expect } from 'bun:test';
import { readdirSync } from 'fs';
import { join } from 'path';
import { isBinaryBuild, BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults';

// Resolve the on-disk defaults directories relative to this test file so the
// tests work regardless of cwd. From packages/workflows/src/defaults go up
// four levels to the repo root, then into .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

function listNames(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir)
    .filter(f => extensions.some(ext => f.endsWith(ext)))
    .map(f => {
      const ext = extensions.find(e => f.endsWith(e))!;
      return f.slice(0, -ext.length);
    })
    .sort();
}

describe('bundled-defaults', () => {
  describe('isBinaryBuild', () => {
    it('should return false in dev/test mode', () => {
      // `isBinaryBuild()` reads the build-time constant `BUNDLED_IS_BINARY` from
      // `@archon/paths`. In dev/test mode it is `false`. It is only rewritten to
      // `true` by `scripts/build-binaries.sh` before `bun build --compile`.
      // Coverage of the `true` branch is via local binary smoke testing (see #979).
      expect(isBinaryBuild()).toBe(false);
    });
  });

  describe('bundle completeness', () => {
    // These assertions are the canary for bundle drift: if someone adds a
    // default file without regenerating bundled-defaults.generated.ts, the
    // bundle is missing in compiled binaries (see #979 context). The generator
    // is `scripts/generate-bundled-defaults.ts`, and `bun run check:bundled`
    // verifies the generated file is up to date in CI.

    it('BUNDLED_COMMANDS contains every .md file in .archon/commands/defaults/', () => {
      const onDisk = listNames(COMMANDS_DIR, ['.md']);
      const bundled = Object.keys(BUNDLED_COMMANDS).sort();
      expect(bundled).toEqual(onDisk);
    });

    it('BUNDLED_WORKFLOWS contains every .yaml/.yml file in .archon/workflows/defaults/', () => {
      const onDisk = listNames(WORKFLOWS_DIR, ['.yaml', '.yml']);
      const bundled = Object.keys(BUNDLED_WORKFLOWS).sort();
      expect(bundled).toEqual(onDisk);
    });
  });

  describe('BUNDLED_COMMANDS', () => {
    it('should have non-empty content for all commands', () => {
      for (const [, content] of Object.entries(BUNDLED_COMMANDS)) {
        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-pr-review-scope should read .pr-number before other discovery', () => {
      const content = BUNDLED_COMMANDS['archon-pr-review-scope'];
      expect(content).toContain('$ARTIFACTS_DIR/.pr-number');
      expect(content).toContain('PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number');
    });

    it('archon-create-pr should write .pr-number to artifacts', () => {
      const content = BUNDLED_COMMANDS['archon-create-pr'];
      expect(content).toContain('echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"');
    });
  });

  describe('BUNDLED_WORKFLOWS', () => {
    it('should have non-empty content for all workflows', () => {
      for (const [, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-workflow-builder should have validate-before-save node ordering and key constraints', () => {
      const content = BUNDLED_WORKFLOWS['archon-workflow-builder'];
      expect(content).toContain('id: validate-yaml');
      expect(content).toContain('depends_on: [validate-yaml]');
      expect(content).toContain('denied_tools: [Edit, Bash]');
      expect(content).toContain('output_format:');
      expect(content).toContain('workflow_name');
    });

    it('should have valid YAML structure', () => {
      for (const [, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        expect(content).toContain('name:');
        expect(content).toContain('description:');
        expect(content.includes('nodes:')).toBe(true);
      }
    });
  });
});
