/**
 * A project's declared checks file, as a console reads it to show a pack's settings: under
 * `checks:`, one entry per check with a `name` and the command to `run` from the project's
 * root. The pack that runs the file owns its shape and says so in the description of the
 * setting that names it; this is the console's reading of that description, used only for
 * display. Other keys are kept and ignored, so a pack may add fields; a file that does not
 * match is shown as unreadable with its path.
 */
import { z } from 'zod';

export const factoryChecksFileSchema = z.looseObject({
  checks: z.array(z.looseObject({ name: z.string().min(1), run: z.string().min(1) })),
});
