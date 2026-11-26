/**
 * A pack's view file: the How it works explainer a console shows for the pack, hand-drawn by
 * its author as `<pack>/.shared/factory-view.json`. It is the explainer only: a one-paragraph
 * `summary` and the How it works picture (`factory-view-how-it-works.ts`). Everything else a
 * console shows about a pack (its stages, steps and outcomes and their words, its groups, and
 * the declarations it reads runs with) comes from the pack graph, which serves the workflows'
 * own `display:` blocks and the pack document's front matter (`display.ts`, `pack-document.ts`).
 *
 * The file is read with its envelope strict but forgiving (`factory-view-read.ts`): a key it
 * does not know, an older file's `stages` or `outcomes` among them, is reported and left out.
 * Where the picture names stages, they are reconciled with the pack graph
 * (`factory-view-check.ts`); both run when the file is read and in `bun run check:factory-view`.
 */
import { z } from 'zod';
import { howItWorksSchema } from './factory-view-how-it-works';

export const FACTORY_VIEW_FILE = 'factory-view.json';

export const factoryViewSchema = z.strictObject({
  version: z.literal(1),
  /** One paragraph, plain words: what goes in, what comes out, where people step in. */
  summary: z.string().min(1).max(1200),
  howItWorks: howItWorksSchema,
});
export type FactoryView = z.infer<typeof factoryViewSchema>;

/**
 * What is wrong with a view file: every kind is an error `check:factory-view` fails on, and a
 * console shows them all while it draws what is left.
 *
 * - `unreadable`: the file is not JSON, or its envelope (version, summary, How it works) does
 *   not read. The view is null; nothing else is reported.
 * - `unknown`: a key the file does not have (an older file's `stages`, a misspelt key); it is
 *   left out and the rest kept.
 * - `dropped`: the How it works picture names a stage the pack graph lacks, or joins stages no
 *   arrow connects; that card's stage or that edge is left out.
 *
 * `path` is where in the file, as a zod issue path, naming the entry as the author wrote it.
 */
export const factoryViewProblemSchema = z.object({
  kind: z.enum(['unreadable', 'unknown', 'dropped']),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type FactoryViewProblem = z.infer<typeof factoryViewProblemSchema>;
