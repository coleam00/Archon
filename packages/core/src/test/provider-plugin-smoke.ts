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
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { MessageChunk } from '@archon/provider-contract';
import { removeTempTree } from '@archon/paths/test-utils';
import { inspectProviderPlugin } from '../providers/inspect-provider-plugin';
import { processProviderRegistration } from '../providers/process-registration';

const CLAUDE_CODE_NOT_FOUND = 'Claude Code not found';
const DUMMY_AWS_KEY_ID = 'AKIAARCHONSMOKEPROBE';
const STUB_ERROR_TYPE = 'UnrecognizedClientException';

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

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'initialize' && args[0]) await smokeInitialize(args[0], args.slice(1));
  else if (mode === 'claude-code' && args.length === 2) await smokeClaudeCode(args[0], args[1]);
  else if (mode === 'pi-bedrock' && args.length === 1) await smokePiBedrock(args[0]);
  else {
    throw new Error(
      'Usage: provider-plugin-smoke.ts initialize <version> <binary>... | claude-code <missing|installed> <binary> | pi-bedrock <binary>'
    );
  }
}
