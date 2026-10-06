import { z } from 'zod';
import { checkChangedEventSchema } from './events';

export const rerunGroupSchema = z.object({
  id: z.string().min(1),
  attempt: z.number().int().positive(),
});
export const selectedCheckSchema = z.object({
  unit: checkChangedEventSchema.shape.unit,
  rerun: rerunGroupSchema.nullable(),
});
export const checkSelectionSchema = z.array(selectedCheckSchema).superRefine((units, ctx) => {
  const identities = new Set<string>();
  for (const [index, { unit }] of units.entries()) {
    const key = JSON.stringify([unit.kind, unit.id]);
    if (identities.has(key))
      ctx.addIssue({ code: 'custom', message: 'Duplicate check unit', path: [index] });
    identities.add(key);
  }
});
export type SelectedCheck = z.infer<typeof selectedCheckSchema>;

export const selectedChecksSchema = checkSelectionSchema.min(1);
