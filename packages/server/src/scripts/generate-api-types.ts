import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { format, resolveConfig } from 'prettier';
import { registerApiRoutes } from '../routes/api';

const OUTPUT_PATH = resolve(import.meta.dir, '../../../web/src/lib/api.generated.d.ts');
const GENERATOR_PATH = resolve(
  import.meta.dir,
  '../../../web/node_modules/openapi-typescript/bin/cli.js'
);

/**
 * Upper bound on the openapi-typescript child. The measured cost of this child is
 * ~270 ms (#2931), so 60 s is over two orders of magnitude of headroom — the same
 * bound, chosen the same way, as the `tar` child in `archon serve`. It exists
 * because this script runs inside `bun run validate` and inside the windows CI
 * leg, neither of which has anything else that would end a stalled child.
 */
const GENERATOR_TIMEOUT_MS = 60_000;

/**
 * Run openapi-typescript over `schemaJson` and return its stdout.
 *
 * The schema is staged on disk and handed to the child as an inherited
 * descriptor. Passing the bytes as `stdin: <Uint8Array>` instead makes the parent
 * own a channel it has to pump and close, and this payload is ~84 KB — larger
 * than a pipe buffer, so it is never a single write. The identical shape in
 * `archon serve` sat blocked on windows with no upper bound until it was replaced
 * by a staged file (#2924, #2928); this was the last copy of it in the repository.
 *
 * Exported for tests; `timeoutMs` defaults to the production bound because the
 * only way to watch this guard end a genuinely stuck child is to shorten it.
 */
export async function runOpenApiGenerator(
  schemaJson: string,
  timeoutMs: number = GENERATOR_TIMEOUT_MS
): Promise<string> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'archon-openapi-schema-'));
  let boundFired = false;
  let bound: ReturnType<typeof setTimeout> | undefined;
  try {
    const schemaPath = join(stagingDir, 'openapi.json');
    await writeFile(schemaPath, schemaJson);
    const generator = Bun.spawn([process.execPath, GENERATOR_PATH], {
      stdin: Bun.file(schemaPath),
      stdout: 'pipe',
      stderr: 'inherit',
    });
    // A parent-owned timer rather than Bun's `timeout:` option, for the same
    // reason as the extractor in `archon serve`: the option reports only through
    // `signalCode`, which is the platform's account of how the child died and
    // cannot separate our limit from a kill by anything else on the machine.
    bound = setTimeout(() => {
      boundFired = true;
      generator.kill();
    }, timeoutMs);
    // Drained while waiting on exit, not after: a stdout pipe nobody reads is its
    // own deadlock once the child fills it.
    const [output, exitCode] = await Promise.all([
      new Response(generator.stdout).text(),
      generator.exited,
    ]);
    if (boundFired) {
      throw new Error(
        `Timed out generating API types: openapi-typescript (${GENERATOR_PATH}) did not finish ` +
          `within ${timeoutMs}ms and was killed. Nothing was written.`
      );
    }
    if (exitCode !== 0) {
      const killedBy = generator.signalCode ? `, killed by ${generator.signalCode}` : '';
      throw new Error(`openapi-typescript failed (exit ${exitCode}${killedBy}).`);
    }
    return output;
  } finally {
    clearTimeout(bound);
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function generateApiTypes(): Promise<string> {
  const app = new OpenAPIHono();
  registerApiRoutes(app, {} as never, {} as never);

  const response = await app.request('/api/openapi.json');
  if (!response.ok) {
    throw new Error(`OpenAPI route returned ${response.status}.`);
  }

  const output = await runOpenApiGenerator(JSON.stringify(await response.json()));
  return format(output, { ...(await resolveConfig(OUTPUT_PATH)), parser: 'typescript' });
}

export type ApiTypesOutcome = 'ok' | 'stale' | 'written';

/**
 * Decides what to do with freshly generated types. Check mode must never write:
 * the CI guard only means anything if a stale tree stays stale, so the same
 * `--check` a developer runs reproduces the failure instead of quietly fixing it.
 */
export async function applyApiTypes(options: {
  outputPath: string;
  generated: string;
  checkOnly: boolean;
}): Promise<ApiTypesOutcome> {
  const { outputPath, generated, checkOnly } = options;
  if (!checkOnly) {
    await writeFile(outputPath, generated);
    return 'written';
  }

  // A Windows checkout with core.autocrlf holds byte-different but equivalent
  // content, so compare on normalized line endings rather than failing the guard.
  const existing = await readFile(outputPath, 'utf8');
  return existing.replace(/\r\n/g, '\n') === generated ? 'ok' : 'stale';
}

if (import.meta.main) {
  try {
    const outcome = await applyApiTypes({
      outputPath: OUTPUT_PATH,
      generated: await generateApiTypes(),
      checkOnly: process.argv.includes('--check'),
    });
    if (outcome === 'stale') {
      console.error('api.generated.d.ts is stale.\nRun: bun run generate:api-types');
      process.exit(2);
    }
    console.log(outcome === 'ok' ? 'check:api-types OK' : `Generated ${OUTPUT_PATH}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
