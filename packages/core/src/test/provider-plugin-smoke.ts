/**
 * Release smoke for the compiled provider plugins, driven through the same host code
 * `archon provider add` and a run use.
 *
 *   initialize <version> <plugin binary>...   each plugin answers with its id and version
 *   claude-code <missing|installed> <binary>  a one-turn Claude query reports, or does not
 *                                            report, the resolver's "Claude Code not found"
 *   pi-bedrock <binary>                       a Bedrock query with dummy AWS keys reaches a
 *                                            local stub endpoint and fails with its credential
 *                                            error, not a module-load error
 *   pi-oauth <binary>                         a credential check on a stored xAI OAuth grant,
 *                                            with no turn run first, reports it usable
 *   pi-oauth-doctor <archon> <pi binary>      the compiled `archon doctor`, with the Pi plugin
 *                                            installed in a temp ARCHON_HOME, reports a stored
 *                                            xAI and a stored ChatGPT OAuth grant usable, and
 *                                            neither usable with no grant stored
 */
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  maintainedProviderPluginId,
  providerManifestSchema,
  providerReceiptSchema,
} from '@archon/plugin-manifest';
import { receiptPath } from '@archon/plugin-manifest/store';
import type { MessageChunk } from '@archon/provider-contract';
import { removeTempTree } from '@archon/paths/test-utils';
import { inspectProviderPlugin } from '../providers/inspect-provider-plugin';
import { processProviderRegistration } from '../providers/process-registration';

const CLAUDE_CODE_NOT_FOUND = 'Claude Code not found';
const DUMMY_AWS_KEY_ID = 'AKIAARCHONSMOKEPROBE';
const STUB_ERROR_TYPE = 'UnrecognizedClientException';

/** A stored Pi OAuth grant that is valid for an hour, so nothing tries to refresh it. */
function dummyOAuthGrant(): Record<string, string | number> {
  return {
    type: 'oauth',
    access: 'archon-smoke-dummy-access',
    refresh: 'archon-smoke-dummy-refresh',
    expires: Date.now() + 3_600_000,
  };
}

async function smokeInitialize(version: string, binaries: string[]): Promise<void> {
  if (binaries.length === 0) throw new Error('No provider plugin binaries to smoke');
  for (const binary of binaries) {
    const descriptor = await inspectProviderPlugin(resolve(binary));
    if (!basename(binary).startsWith(`archon-provider-${descriptor.id}-`)) {
      throw new Error(`${binary} answered initialize as provider '${descriptor.id}'`);
    }
    if (descriptor.version !== version) {
      throw new Error(`${binary} reports version ${descriptor.version}, expected ${version}`);
    }
    console.log(`${basename(binary)}: ${descriptor.id} ${descriptor.version}`);
  }
}

/** The text a one-turn query surfaced, whether the provider threw or reported a failed result. */
async function claudeQueryOutput(binary: string): Promise<string> {
  const path = resolve(binary);
  const descriptor = await inspectProviderPlugin(path);
  if (descriptor.id !== 'claude') throw new Error(`${binary} is provider '${descriptor.id}'`);
  const provider = processProviderRegistration(descriptor, [path]).factory();
  const cwd = await mkdtemp(join(tmpdir(), 'archon-claude-smoke-'));
  const output: string[] = [];
  try {
    for await (const chunk of provider.sendQuery('Reply with OK.', cwd)) {
      output.push(JSON.stringify(chunk));
    }
  } catch (error) {
    output.push(error instanceof Error ? error.message : String(error));
  } finally {
    await removeTempTree(cwd);
  }
  return output.join('\n');
}

async function smokeClaudeCode(expectation: string, binary: string): Promise<void> {
  if (expectation !== 'missing' && expectation !== 'installed') {
    throw new Error(`Expected 'missing' or 'installed', got '${expectation}'`);
  }
  const output = await claudeQueryOutput(binary);
  console.log(output);
  const notFound = output.includes(CLAUDE_CODE_NOT_FOUND);
  if (expectation === 'missing' && !notFound) {
    throw new Error(`Claude plugin without Claude Code did not report '${CLAUDE_CODE_NOT_FOUND}'`);
  }
  if (expectation === 'installed' && notFound) {
    throw new Error('Claude plugin did not find the installed Claude Code');
  }
}

/**
 * pi-ai loads its Bedrock client lazily. Without the shim `sdk-setup.ts` registers, that
 * load is a computed-specifier import a compiled binary cannot embed, so a signed request
 * arriving at the stub proves the module loaded inside the compiled plugin.
 */
async function smokePiBedrock(binary: string): Promise<void> {
  const path = resolve(binary);
  const descriptor = await inspectProviderPlugin(path);
  if (descriptor.id !== 'pi') throw new Error(`${binary} is provider '${descriptor.id}'`);
  const requests: { method: string; pathname: string; authorization: string }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
        authorization: request.headers.get('authorization') ?? '',
      });
      return Response.json(
        { message: 'The security token included in the request is invalid.' },
        { status: 403, headers: { 'x-amzn-errortype': `${STUB_ERROR_TYPE}:smoke-stub` } }
      );
    },
  });
  const agentDir = await mkdtemp(join(tmpdir(), 'archon-pi-bedrock-smoke-'));
  const chunks: MessageChunk[] = [];
  const output: string[] = [];
  try {
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: { 'amazon-bedrock': { baseUrl: `http://127.0.0.1:${server.port}` } },
      })
    );
    const provider = processProviderRegistration(descriptor, [path]).factory();
    for await (const chunk of provider.sendQuery('Reply with OK.', agentDir, undefined, {
      model: 'amazon-bedrock/amazon.nova-lite-v1:0',
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        AWS_ACCESS_KEY_ID: DUMMY_AWS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: 'archon-smoke-dummy-secret',
        AWS_REGION: 'us-east-1',
        // The stub speaks cleartext HTTP/1.1; the Bedrock client's default handler is HTTP/2.
        AWS_BEDROCK_FORCE_HTTP1: '1',
      },
    })) {
      chunks.push(chunk);
      output.push(JSON.stringify(chunk));
    }
  } catch (error) {
    output.push(error instanceof Error ? error.message : String(error));
  } finally {
    await server.stop(true);
    await removeTempTree(agentDir);
  }
  console.log(output.join('\n'));
  console.log('Stub requests:', JSON.stringify(requests));
  const signed = requests.some(
    request =>
      request.pathname.endsWith('/converse-stream') &&
      request.authorization.includes(`Credential=${DUMMY_AWS_KEY_ID}/`)
  );
  if (!signed) {
    throw new Error(
      'Pi Bedrock request never reached the endpoint: the Bedrock module did not load in the compiled plugin'
    );
  }
  const credentialError = chunks.some(
    chunk =>
      chunk.type === 'result' &&
      chunk.isError === true &&
      chunk.errors?.some(error => error.includes(STUB_ERROR_TYPE))
  );
  if (!credentialError) {
    throw new Error("Pi Bedrock query did not fail with the stub's credential error");
  }
}

/**
 * pi-ai loads each subscription OAuth flow through a computed-specifier import a compiled
 * binary cannot embed, so a stored OAuth grant only resolves once `sdk-setup.ts` has
 * registered the bundled flows. A credential check is the doctor and preflight path, which
 * never runs a turn first, so it has to register them itself.
 */
async function smokePiOAuth(binary: string): Promise<void> {
  const path = resolve(binary);
  const descriptor = await inspectProviderPlugin(path);
  if (descriptor.id !== 'pi') throw new Error(`${binary} is provider '${descriptor.id}'`);
  const agentDir = await mkdtemp(join(tmpdir(), 'archon-pi-oauth-smoke-'));
  try {
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ xai: dummyOAuthGrant() }));
    const provider = processProviderRegistration(descriptor, [path]).factory();
    const status = await provider.checkCredential({
      model: 'xai/grok-4.3',
      // An inherited XAI_API_KEY would satisfy the check without the stored grant.
      env: { PI_CODING_AGENT_DIR: agentDir, XAI_API_KEY: '' },
      signal: AbortSignal.timeout(60_000),
    });
    console.log('Credential status:', JSON.stringify(status));
    if (status.state !== 'usable') {
      throw new Error(`Pi OAuth grant was not usable: ${JSON.stringify(status)}`);
    }
  } finally {
    await removeTempTree(agentDir);
  }
}

const PI_OAUTH_DOCTOR_MODELS = [
  { model: 'xai/grok-4.7', grant: 'xai' },
  { model: 'openai-codex/gpt-5.5', grant: 'openai-codex' },
] as const;

const PI_DOCTOR_USABLE_LINES = [
  '✓ pi: Pi backend credentials: Backend credential status: usable',
  '✓ Assistant login: pi: usable',
];

/**
 * Write the plugin and its receipt the way `archon provider add` lays them out, so the
 * compiled CLI loads it as an installed maintained provider.
 */
async function installPiPlugin(pluginsDir: string, binary: string): Promise<void> {
  const path = resolve(binary);
  const descriptor = await inspectProviderPlugin(path);
  if (descriptor.id !== 'pi') throw new Error(`${binary} is provider '${descriptor.id}'`);
  const manifest = providerManifestSchema.parse(
    JSON.parse(
      await readFile(
        resolve(import.meta.dir, '../../../../plugins/provider-pi/archon-plugin.json'),
        'utf8'
      )
    )
  );
  const fileName = `${manifest.executable}${process.platform === 'win32' ? '.exe' : ''}`;
  const bytes = await readFile(path);
  await mkdir(pluginsDir, { recursive: true });
  await copyFile(path, join(pluginsDir, fileName));
  await chmod(join(pluginsDir, fileName), 0o755);
  const id = maintainedProviderPluginId('pi');
  const receipt = providerReceiptSchema.parse({
    schemaVersion: 1,
    id,
    manifest,
    tag: `v${descriptor.version}`,
    // Receipt metadata only; the loader never reads it, so the smoke does not need git.
    commit: '0'.repeat(40),
    installedAt: new Date().toISOString(),
    files: [{ path: fileName, sha256: createHash('sha256').update(bytes).digest('hex') }],
    descriptor,
  });
  const file = receiptPath(pluginsDir, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

interface DoctorCase {
  archon: string;
  cwd: string;
  agentDir: string;
  env: Record<string, string | undefined>;
  model: string;
  grant: string;
  stored: boolean;
}

/**
 * One `archon doctor` run with `grant` stored or not. A stored grant must make both
 * doctor lines usable; with an empty auth.json neither may be, so a pass cannot come
 * from anywhere else.
 * The exit status is reported so a timeout is not misread as a missing line.
 */
async function checkDoctorCase(run: DoctorCase): Promise<void> {
  const grants = run.stored ? { [run.grant]: dummyOAuthGrant() } : {};
  await writeFile(join(run.agentDir, 'auth.json'), JSON.stringify(grants));
  const child = Bun.spawn([resolve(run.archon), 'doctor'], {
    cwd: run.cwd,
    env: run.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(120_000),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const status = child.signalCode ? `signal ${child.signalCode}` : `exit ${child.exitCode}`;
  const stored = run.stored ? `on a stored ${run.grant} OAuth grant` : 'with no stored grant';
  const label = `${run.model} ${stored} (${status})`;
  console.log(`--- archon doctor, ${label} ---`);
  console.log(stdout);
  if (stderr.trim()) console.log(stderr);
  for (const line of PI_DOCTOR_USABLE_LINES) {
    if (stdout.includes(line) !== run.stored) {
      throw new Error(
        `archon doctor for ${label} ${run.stored ? 'did not report' : 'reported'} '${line}'`
      );
    }
  }
}

/**
 * The doctor path on top of `pi-oauth`: doctor loads the installed plugin, maps its
 * diagnostics, and runs the assistant login check, so a break in any of those shows here.
 */
async function smokePiOAuthDoctor(archon: string, binary: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'archon-pi-oauth-doctor-'));
  try {
    const archonHome = join(root, 'home');
    const agentDir = join(root, 'pi');
    const cwd = join(root, 'cwd');
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await installPiPlugin(join(archonHome, 'plugins'), binary);
    // An inherited key would satisfy the check without the stored grant under test.
    const env = {
      ...process.env,
      XAI_API_KEY: '',
      OPENAI_API_KEY: '',
      ARCHON_PI_AUTH_PATH: '',
      ARCHON_HOME: archonHome,
      PI_CODING_AGENT_DIR: agentDir,
      DO_NOT_TRACK: '1',
    };
    for (const { model, grant } of PI_OAUTH_DOCTOR_MODELS) {
      await writeFile(
        join(archonHome, 'config.yaml'),
        `defaultAssistant: pi\nassistants:\n  pi:\n    model: ${model}\n`
      );
      for (const stored of [true, false]) {
        await checkDoctorCase({ archon, cwd, agentDir, env, model, grant, stored });
      }
    }
  } finally {
    await removeTempTree(root);
  }
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'initialize' && args[0]) await smokeInitialize(args[0], args.slice(1));
  else if (mode === 'claude-code' && args.length === 2) await smokeClaudeCode(args[0], args[1]);
  else if (mode === 'pi-bedrock' && args.length === 1) await smokePiBedrock(args[0]);
  else if (mode === 'pi-oauth' && args.length === 1) await smokePiOAuth(args[0]);
  else if (mode === 'pi-oauth-doctor' && args.length === 2)
    await smokePiOAuthDoctor(args[0], args[1]);
  else {
    throw new Error(
      'Usage: provider-plugin-smoke.ts initialize <version> <binary>... | claude-code <missing|installed> <binary> | pi-bedrock <binary> | pi-oauth <binary> | pi-oauth-doctor <archon> <pi binary>'
    );
  }
}
