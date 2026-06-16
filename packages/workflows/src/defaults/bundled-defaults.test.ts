import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { isBinaryBuild, BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults';

// Resolve the on-disk defaults directories relative to this test file so the
// tests work regardless of cwd. From packages/workflows/src/defaults go up
// four levels to the repo root, then into .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

interface VerifyPrBaseBlock {
  workflowName: string;
  block: string;
}

function extractVerifyPrBaseBlocks(workflowName: string, content: string): VerifyPrBaseBlock[] {
  const nodeLinePattern = /^(\s*)-\s+id:\s+(.+)\s*$/;
  const lines = content.split('\n');
  const blocks: VerifyPrBaseBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = nodeLinePattern.exec(lines[index]);
    if (match === null || match[2] !== 'verify-pr-base') {
      continue;
    }

    const nodeIndent = match[1].length;
    let endIndex = index + 1;
    while (endIndex < lines.length) {
      const nextNodeMatch = nodeLinePattern.exec(lines[endIndex]);
      if (nextNodeMatch !== null && nextNodeMatch[1].length === nodeIndent) {
        break;
      }
      endIndex += 1;
    }

    blocks.push({ workflowName, block: lines.slice(index, endIndex).join('\n') });
  }

  return blocks;
}

function getBundledVerifyPrBaseBlocks(): VerifyPrBaseBlock[] {
  return Object.entries(BUNDLED_WORKFLOWS).flatMap(([workflowName, content]) =>
    extractVerifyPrBaseBlocks(workflowName, content)
  );
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
    // bundle would be missing in compiled binaries (see #979 context). The
    // generator is `scripts/generate-bundled-defaults.ts`, and
    // `bun run check:bundled` verifies the generated file is up to date.

    it('BUNDLED_COMMANDS contains every .md file in .archon/commands/defaults/', () => {
      const onDisk = readdirSync(COMMANDS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -'.md'.length))
        .sort();
      expect(Object.keys(BUNDLED_COMMANDS).sort()).toEqual(onDisk);
    });

    it('BUNDLED_WORKFLOWS contains every .yaml/.yml file in .archon/workflows/defaults/', () => {
      const onDisk = readdirSync(WORKFLOWS_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => f.replace(/\.ya?ml$/, ''))
        .sort();
      expect(Object.keys(BUNDLED_WORKFLOWS).sort()).toEqual(onDisk);
    });

    it('bundled content matches on-disk file content (defense against generator corruption)', () => {
      // Bundled content is LF-normalized by the generator so it stays identical
      // regardless of the checkout's line-ending policy. Match that here.
      const readLF = (path: string): string => readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');

      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        const diskContent = readLF(join(COMMANDS_DIR, `${name}.md`));
        expect(content).toBe(diskContent);
      }
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        // Workflows may be .yaml or .yml — prefer .yaml, fall back.
        let diskContent: string;
        try {
          diskContent = readLF(join(WORKFLOWS_DIR, `${name}.yaml`));
        } catch {
          diskContent = readLF(join(WORKFLOWS_DIR, `${name}.yml`));
        }
        expect(content).toBe(diskContent);
      }
    });
  });

  describe('BUNDLED_COMMANDS', () => {
    it('every command has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_COMMANDS)) {
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
    it('every workflow has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
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

    it('archon-adversarial-dev init-workspace should avoid non-portable sed -i', () => {
      const content = BUNDLED_WORKFLOWS['archon-adversarial-dev'];
      expect(content).toContain('STATE_TMP="$ARTIFACTS/state.json.tmp"');
      expect(content).toContain(
        'sed "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/" "$ARTIFACTS/state.json" > "$STATE_TMP"'
      );
      expect(content).not.toContain('sed -i "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/"');
    });

    it('verify-pr-base nodes should resolve and edit PRs explicitly', () => {
      const blocks = getBundledVerifyPrBaseBlocks();
      expect(blocks.length).toBeGreaterThan(0);

      const failures = blocks.flatMap(({ workflowName, block }) => {
        const blockFailures: string[] = [];
        const artifactPrNumberIndex = block.indexOf('$ARTIFACTS_DIR/.pr-number');
        const branchFallbackMatch =
          /gh pr view\s+"(?:\$CURRENT_BRANCH|\$\{CURRENT_BRANCH\})"\s+--json\s+number/.exec(block);
        const branchFallbackIndex = branchFallbackMatch?.index ?? -1;

        if (block.includes('gh pr view --json baseRefName')) {
          blockFailures.push(
            `${workflowName}: verify-pr-base uses bare gh pr view --json baseRefName`
          );
        }
        if (block.includes('gh pr view --json number')) {
          blockFailures.push(`${workflowName}: verify-pr-base uses bare gh pr view --json number`);
        }
        if (artifactPrNumberIndex === -1) {
          blockFailures.push(
            `${workflowName}: verify-pr-base does not read $ARTIFACTS_DIR/.pr-number`
          );
        }
        if (branchFallbackIndex === -1) {
          blockFailures.push(
            `${workflowName}: verify-pr-base does not fall back to gh pr view "$CURRENT_BRANCH" --json number`
          );
        }
        if (
          artifactPrNumberIndex !== -1 &&
          branchFallbackIndex !== -1 &&
          artifactPrNumberIndex > branchFallbackIndex
        ) {
          blockFailures.push(
            `${workflowName}: verify-pr-base checks current branch before .pr-number`
          );
        }
        if (!/if \[ -z "(?:\$PR_NUMBER|\$\{PR_NUMBER\})" \][\s\S]*?exit 1/.test(block)) {
          blockFailures.push(
            `${workflowName}: verify-pr-base does not have a fail-fast guard (if [ -z "$PR_NUMBER" ]; then … exit 1)`
          );
        }
        if (
          !/gh pr view\s+"(?:\$PR_NUMBER|\$\{PR_NUMBER\})"\s+--json\s+[^\n]*baseRefName/.test(block)
        ) {
          blockFailures.push(
            `${workflowName}: verify-pr-base does not view baseRefName via "$PR_NUMBER"`
          );
        }
        if (!/gh pr edit\s+"(?:\$PR_NUMBER|\$\{PR_NUMBER\})"\s+--base/.test(block)) {
          blockFailures.push(`${workflowName}: verify-pr-base does not edit via "$PR_NUMBER"`);
        }

        return blockFailures;
      });

      expect(failures).toEqual([]);
    });

    it('should have valid YAML structure', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content).toContain('name:');
        expect(content).toContain('description:');
        expect(content.includes('nodes:')).toBe(true);
      }
    });
  });
});
