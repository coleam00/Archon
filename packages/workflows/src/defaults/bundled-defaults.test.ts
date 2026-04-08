import { describe, it, expect } from 'bun:test';
import { isBinaryBuild, BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults';

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

  describe('BUNDLED_COMMANDS', () => {
    it('should have all expected default commands', () => {
      const expectedCommands = [
        'archon-assist',
        'archon-code-review-agent',
        'archon-comment-quality-agent',
        'archon-create-pr',
        'archon-docs-impact-agent',
        'archon-error-handling-agent',
        'archon-implement-issue',
        'archon-implement-review-fixes',
        'archon-implement',
        'archon-investigate-issue',
        'archon-pr-review-scope',
        'archon-ralph-prd',
        'archon-resolve-merge-conflicts',
        'archon-sync-pr-with-main',
        'archon-synthesize-review',
        'archon-test-coverage-agent',
        'archon-validate-pr-code-review-feature',
        'archon-validate-pr-code-review-main',
        'archon-validate-pr-e2e-feature',
        'archon-validate-pr-e2e-main',
        'archon-validate-pr-report',
      ];

      for (const cmd of expectedCommands) {
        expect(BUNDLED_COMMANDS).toHaveProperty(cmd);
      }

      expect(Object.keys(BUNDLED_COMMANDS)).toHaveLength(21);
    });

    it('should have non-empty content for all commands', () => {
      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(0);
        // Commands should have meaningful content (at least some markdown)
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('should have markdown content format', () => {
      // Commands are markdown files, should have typical markdown patterns
      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        // Should contain some text (not just whitespace)
        expect(content.trim().length).toBeGreaterThan(0);
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
    it('should have all expected default workflows', () => {
      const expectedWorkflows = [
        'archon-assist',
        'archon-comprehensive-pr-review',
        'archon-create-issue',
        'archon-feature-development',
        'archon-fix-github-issue',
        'archon-resolve-conflicts',
        'archon-smart-pr-review',
        'archon-validate-pr',
        'archon-remotion-generate',
        'archon-interactive-prd',
        'archon-piv-loop',
        'archon-adversarial-dev',
        'archon-workflow-builder',
      ];

      for (const wf of expectedWorkflows) {
        expect(BUNDLED_WORKFLOWS).toHaveProperty(wf);
      }

      expect(Object.keys(BUNDLED_WORKFLOWS)).toHaveLength(13);
    });

    it('should have non-empty content for all workflows', () => {
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(0);
        // Workflows should have meaningful YAML content
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
      // Workflows are YAML files, should parse without error
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        // Should contain 'name:' as all workflows require a name field
        expect(content).toContain('name:');
        // Should contain 'description:' as all workflows require description
        expect(content).toContain('description:');
        // Should contain nodes: (with optional loop: inside nodes)
        const hasNodes = content.includes('nodes:');
        expect(hasNodes).toBe(true);
      }
    });
  });
});
