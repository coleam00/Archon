import { z } from 'zod';
import { workflowPackManifestSchema } from '@archon/plugin-manifest';
import { installedPluginRecordSchema } from './installed-record';

const relativePath = z
  .string()
  .refine(
    path =>
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !path.includes('\0') &&
      path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a normalized relative path using /'
  );

export const sourceUnitSchema = z
  .object({
    root: relativePath,
    files: z.array(
      z
        .object({
          path: relativePath,
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().nonnegative().safe(),
        })
        .strict()
    ),
  })
  .strict();

export const indexedInstalledPluginSchema = installedPluginRecordSchema
  .extend({
    manifest: workflowPackManifestSchema,
  })
  .strict();

export type SourceUnit = z.infer<typeof sourceUnitSchema>;
export type IndexedInstalledPlugin = z.infer<typeof indexedInstalledPluginSchema>;

type UnitIndex = {
  units: SourceUnit[];
  installed_plugins: IndexedInstalledPlugin[];
  scopes: string[];
  file_count: number;
  byte_count: number;
};

function orderedUnique(paths: readonly string[]): boolean {
  return paths.every((path, index) => index === 0 || paths[index - 1] < path);
}

function installedRoots(index: UnitIndex, ctx: z.RefinementCtx): Set<string> {
  const roots = new Set<string>();
  for (const plugin of index.installed_plugins) {
    const owner = plugin.id.split('/')[0];
    const root = `installed/${plugin.key}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(owner) || plugin.key !== `${owner}.${plugin.manifest.name}`) {
      ctx.addIssue({
        code: 'custom',
        message: 'Installed key must agree with its id and manifest name',
      });
    }
    if (roots.has(root))
      ctx.addIssue({ code: 'custom', message: 'Duplicate installed plugin key' });
    roots.add(root);
  }
  return roots;
}

export function validateUnitIndex(index: UnitIndex, ctx: z.RefinementCtx): void {
  const roots = installedRoots(index, ctx);
  const allowed = new Set(['project', 'global', 'bundled', ...roots]);
  for (const unit of index.units) {
    if (!allowed.has(unit.root))
      ctx.addIssue({ code: 'custom', message: `Unknown unit root: ${unit.root}` });
    if (!orderedUnique(unit.files.map(file => file.path))) {
      ctx.addIssue({ code: 'custom', message: 'Unit file paths must be unique and sorted' });
    }
  }
  if (!orderedUnique(index.units.map(unit => unit.root))) {
    ctx.addIssue({ code: 'custom', message: 'Unit roots must be unique and sorted' });
  }
  for (const root of roots) {
    if (!index.units.some(unit => unit.root === root)) {
      ctx.addIssue({ code: 'custom', message: `Missing installed unit: ${root}` });
    }
  }
  const scopes = new Set(index.units.map(unit => unit.root.split('/')[0]));
  if (index.scopes.length !== scopes.size || index.scopes.some(scope => !scopes.has(scope))) {
    ctx.addIssue({ code: 'custom', message: 'Scopes must match the unit inventory' });
  }
  const files = index.units.flatMap(unit => unit.files);
  if (
    files.length !== index.file_count ||
    files.reduce((sum, file) => sum + file.size, 0) !== index.byte_count
  ) {
    ctx.addIssue({ code: 'custom', message: 'Capture counts must match the unit inventory' });
  }
}
