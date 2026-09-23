import { extname, isAbsolute } from 'node:path';
import { z } from 'zod';

const commandSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'plugin command must be absolute')
  .refine(
    command => !['.cmd', '.bat'].includes(extname(command).toLowerCase()),
    'plugin command cannot be a .cmd or .bat file'
  )
  .refine(
    command => process.platform !== 'win32' || extname(command).toLowerCase() === '.exe',
    'Windows plugin command must be an .exe file'
  );

export const forgePluginCommandSchema = z.object({
  plugin: z.string().regex(/^[a-z0-9-]+$/),
  command: commandSchema,
  args: z.array(z.string()).default([]),
  token_env: z.string().min(1).optional(),
});
export type ForgePluginCommand = z.infer<typeof forgePluginCommandSchema>;

export const forgeHostPluginSchema = z.union([
  z.string().regex(/^[a-z0-9-]+$/),
  z
    .object({
      plugin: z.string().regex(/^[a-z0-9-]+$/),
      command: commandSchema.optional(),
      args: z.array(z.string()).default([]),
      token_env: z.string().min(1).optional(),
    })
    .refine(value => value.command !== undefined || value.args.length === 0, {
      message: 'host plugin args require an explicit command',
      path: ['args'],
    }),
]);
export type ForgeHostPlugin = z.infer<typeof forgeHostPluginSchema>;

export const forgePluginConfigSchema = z.object({
  plugins: z.array(forgePluginCommandSchema).default([]),
  hosts: z.record(z.string().min(1), forgeHostPluginSchema).default({}),
  pluginDirs: z.array(z.string().min(1)).default([]),
  scanPath: z.boolean().default(true),
});
export type ForgePluginConfig = z.input<typeof forgePluginConfigSchema>;

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}
