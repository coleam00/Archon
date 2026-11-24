/**
 * Skill command - Install an agent skill into a project
 *
 * Without `--pack`, writes the bundled `archon-cli` skill (core SKILL.md plus the
 * operate, setup and authoring reference folders) into
 * <targetPath>/.claude/skills/archon-cli/ (for Claude Code) and
 * <targetPath>/.agents/skills/archon-cli/ (the canonical Codex project-level skill
 * path) so both Claude Code and Codex pick them up. It removes the two retired
 * Archon-owned skill roots, then overwrites existing archon-cli files so only the
 * version shipped with the current binary is active.
 *
 * With `--pack <id>`, copies the skill folder an installed workflow pack declares in
 * its manifest's `skill` field to the same two roots, under the skill's own name.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { cp, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import {
  ARCHON_SKILL_NAME,
  describeIssues,
  PLUGIN_MANIFEST_FILE,
  type PluginReceipt,
  RETIRED_ARCHON_SKILL_NAMES,
  type WorkflowPackManifest,
  type WorkflowPackReceipt,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { packTreePath, scanReceipts } from '@archon/plugin-manifest/store';
import { brokenReceiptNote } from './plugin-common';

/** Write a skill's relative-path→content map under <skillRoot>, creating dirs as needed. */
function writeSkillFiles(skillRoot: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const dest = join(skillRoot, relativePath);
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    writeFileSync(dest, content);
  }
}

/**
 * Copy the bundled Archon skill into <targetPath>/.claude/skills/ (Claude Code)
 * and <targetPath>/.agents/skills/ (Codex):
 *   - `archon-cli` — router + capability references (run/manage/setup/author)
 *
 * Pure file-system helper used by both the standalone `skill add` CLI
 * command and the interactive setup wizard.
 *
 * The `bundled-skill` module is dynamically imported here so that its top-level
 * `import … with { type: 'text' }` statements only execute when this function is
 * actually called. Compiled binaries (`bun build --compile`) still statically
 * analyze the literal-string `import()` and embed the chunk; linked-source
 * installs (`bun link`) don't touch the source skill files unless the user runs
 * `archon setup` or `archon skill add`. Without this indirection, every
 * `archon` invocation — including `archon --help` — fails at module load when
 * the source skill files are missing from disk.
 */
export async function copyArchonSkill(targetPath: string): Promise<void> {
  const { BUNDLED_SKILL_FILES } = await import('../bundled-skill');
  const skillsRoots = [
    join(targetPath, '.claude', 'skills'),
    join(targetPath, '.agents', 'skills'),
  ];

  for (const skillsRoot of skillsRoots) {
    for (const retired of RETIRED_ARCHON_SKILL_NAMES) {
      rmSync(join(skillsRoot, retired), { recursive: true, force: true });
    }
    const currentRoot = join(skillsRoot, ARCHON_SKILL_NAME);
    rmSync(currentRoot, { recursive: true, force: true });
    writeSkillFiles(currentRoot, BUNDLED_SKILL_FILES);
  }
}

/**
 * Install the bundled Archon skill into a project directory.
 *
 * Returns an exit code: 0 on success, 1 on failure.
 */
export async function skillInstallCommand(targetPath: string): Promise<number> {
  const absoluteTarget = resolve(targetPath);

  if (!existsSync(absoluteTarget)) {
    console.error(`Error: Directory does not exist: ${absoluteTarget}`);
    return 1;
  }

  try {
    const { BUNDLED_SKILL_FILES } = await import('../bundled-skill');
    const fileCount = Object.keys(BUNDLED_SKILL_FILES).length;
    const installTargets = [
      join(absoluteTarget, '.claude', 'skills'),
      join(absoluteTarget, '.agents', 'skills'),
    ];
    console.log(
      `Adding Archon skill (archon-cli, ${fileCount} files per destination) into ${installTargets.join(' and ')}`
    );

    await copyArchonSkill(absoluteTarget);
    console.log('Done. Restart Claude Code or Codex to load the skills.');
    return 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.error(`Error: Failed to install skill: ${err.message}`);
    return 1;
  }
}

function isPackReceipt(receipt: PluginReceipt): receipt is WorkflowPackReceipt {
  return receipt.manifest.kind === 'workflow-pack';
}

/**
 * The installed tree's own manifest, not the receipt's copy: a receipt written by an
 * Archon that predates the `skill` field has it stripped, while the tree keeps it.
 */
async function readTreeManifest(tree: string): Promise<WorkflowPackManifest> {
  const file = join(tree, PLUGIN_MANIFEST_FILE);
  const parsed = workflowPackManifestSchema.safeParse(JSON.parse(await readFile(file, 'utf-8')));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** The id of another installed pack that ships a skill named `name`, if any. */
async function packShippingSkill(
  receipts: PluginReceipt[],
  pluginsDir: string,
  packId: string,
  name: string
): Promise<string | undefined> {
  for (const other of receipts.filter(isPackReceipt)) {
    if (other.id === packId) continue;
    // A pack whose tree manifest cannot be read is a discovery error already, and
    // ships no skill anyone could have installed.
    const otherSkill = await readTreeManifest(packTreePath(pluginsDir, other.id, other.commit))
      .then(manifest => manifest.skill)
      .catch(() => undefined);
    if (otherSkill?.name === name) return other.id;
  }
  return undefined;
}

/** Written into each installed pack skill folder: the id of the pack that owns it. */
const PACK_SKILL_OWNER_FILE = '.archon-pack';

/**
 * Why `destination` must not be replaced by `packId`, or undefined when it may be: it is
 * absent, or its owner marker names this pack. A folder another pack installed, or one
 * no `skill add --pack` wrote (a hand copy, the operator's own skill), is refused.
 */
async function ownershipRefusal(destination: string, packId: string): Promise<string | undefined> {
  if (!existsSync(destination)) return undefined;
  let owner: string;
  try {
    owner = (await readFile(join(destination, PACK_SKILL_OWNER_FILE), 'utf-8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return `${destination} exists and archon skill add --pack did not install it; move or delete it, then run this again`;
  }
  return owner === packId
    ? undefined
    : `${destination} holds the skill ${owner} installed, not ${packId}; remove it first if ${owner}'s skill is no longer wanted`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Install the skill an installed workflow pack ships into a project directory,
 * replacing each target folder whole.
 *
 * Returns an exit code: 0 on success, 1 on failure.
 */
export async function packSkillInstallCommand(
  packId: string,
  targetPath: string,
  pluginsDir: string
): Promise<number> {
  const absoluteTarget = resolve(targetPath);
  if (!existsSync(absoluteTarget)) {
    console.error(`Error: Directory does not exist: ${absoluteTarget}`);
    return 1;
  }

  try {
    const { receipts, broken } = await scanReceipts(pluginsDir);
    const brokenSelf = broken.find(entry => entry.id === packId);
    if (brokenSelf) {
      console.error(
        `Error: ${packId} is installed, but its receipt is broken: ${brokenReceiptNote(brokenSelf)}`
      );
      return 1;
    }
    const receipt = receipts.find(entry => entry.id === packId);
    if (!receipt) {
      console.error(`Error: ${packId} is not installed. Install it: archon plugin add ${packId}`);
      return 1;
    }
    if (!isPackReceipt(receipt)) {
      console.error(
        `Error: ${packId} is a ${receipt.manifest.kind} plugin; only workflow packs ship a skill`
      );
      return 1;
    }
    const tree = packTreePath(pluginsDir, receipt.id, receipt.commit);
    const { skill } = await readTreeManifest(tree);
    if (!skill) {
      console.error(
        `Error: ${packId} ships no skill (its ${PLUGIN_MANIFEST_FILE} declares no "skill")`
      );
      return 1;
    }
    // Install checks this too; a tree installed before that check existed may lack it.
    if (!isFile(join(tree, skill.path, 'SKILL.md'))) {
      console.error(
        `Error: ${packId}: skill "${skill.name}" names ${skill.path}, which has no SKILL.md`
      );
      return 1;
    }
    const rival = await packShippingSkill(receipts, pluginsDir, packId, skill.name);
    if (rival) {
      console.error(
        `Error: ${packId} and ${rival} both ship a skill named ${skill.name}; installing it would replace the other pack's skill`
      );
      return 1;
    }

    const destinations = [
      join(absoluteTarget, '.claude', 'skills', skill.name),
      join(absoluteTarget, '.agents', 'skills', skill.name),
    ];
    // The receipts above know only what is installed now. A folder already in the
    // project may belong to a pack since removed, or to a skill since renamed, so the
    // folder's own marker decides; both are checked before either is replaced.
    for (const destination of destinations) {
      const refusal = await ownershipRefusal(destination, packId);
      if (refusal) {
        console.error(`Error: ${refusal}`);
        return 1;
      }
    }
    console.log(`Adding ${packId} skill (${skill.name}) into ${destinations.join(' and ')}`);
    for (const destination of destinations) {
      rmSync(destination, { recursive: true, force: true });
      await cp(join(tree, skill.path), destination, { recursive: true });
      await writeFile(join(destination, PACK_SKILL_OWNER_FILE), `${packId}\n`);
    }
    console.log('Done. Restart Claude Code or Codex to load the skills.');
    return 0;
  } catch (error) {
    console.error(`Error: Failed to install skill: ${(error as Error).message}`);
    return 1;
  }
}
