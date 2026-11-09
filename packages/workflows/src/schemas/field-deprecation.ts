import { z } from 'zod';

export type LegacyPauseShape =
  | 'approval'
  | 'decisions'
  | 'on_reject'
  | 'capture_response'
  | 'interactive_loop';

export type FieldDeprecation = { readonly since: string } & (
  | {
      readonly kind: 'legacy_pause';
      readonly shape: LegacyPauseShape;
      readonly subject: (path: readonly string[]) => string;
      readonly replacement: string;
    }
  | {
      readonly kind: 'prose_until';
      readonly replacement: Readonly<Record<'loop' | 'loop_group', string>>;
    }
);

const deprecations = z.registry<FieldDeprecation>();

export function deprecatedField<S extends z.ZodType>(schema: S, metadata: FieldDeprecation): S {
  deprecations.add(schema, metadata);
  return schema;
}

export function fieldDeprecation(schema: z.core.$ZodType): FieldDeprecation {
  const metadata = deprecations.get(schema);
  if (metadata === undefined) throw new Error('Expected an accepted deprecated field');
  return metadata;
}

export interface DeprecatedField {
  readonly path: readonly string[];
  readonly schema: z.core.$ZodType;
  readonly metadata: FieldDeprecation;
  readonly replacement: string;
  readonly message: string;
}

export function deprecatedFields(
  schema: z.core.$ZodType,
  path: readonly string[] = []
): DeprecatedField[] {
  const fields: DeprecatedField[] = [];
  let current = schema;
  let found = false;
  while (true) {
    const metadata = deprecations.get(current);
    if (metadata !== undefined && !found) {
      const replacement = deprecationReplacement(metadata, path);
      const subject =
        metadata.kind === 'prose_until'
          ? `the prose '${path.join('.')}' completion signal is deprecated.`
          : metadata.subject(path);
      fields.push({
        path,
        schema: current,
        metadata,
        replacement,
        message: `${subject} ${replacement}`,
      });
      found = true;
    }
    if (!(current instanceof z.ZodOptional)) break;
    current = current.unwrap();
  }
  // Arrays (including loop_group.nodes), records and arbitrary JSON are not field owners.
  if (current instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(current.shape)) {
      fields.push(...deprecatedFields(child, [...path, key]));
    }
  }
  return fields;
}

export function deprecationReplacement(
  metadata: FieldDeprecation,
  path: readonly string[]
): string {
  if (metadata.kind === 'legacy_pause') return metadata.replacement;
  const owner = path[0];
  if (owner !== 'loop' && owner !== 'loop_group') {
    throw new Error('Prose-until deprecation requires a loop owner');
  }
  return metadata.replacement[owner];
}
