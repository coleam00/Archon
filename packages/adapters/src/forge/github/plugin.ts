#!/usr/bin/env bun
import { forgeRequestSchema, type ForgeResponse } from '@archon/forge/operations';
import { githubPluginMetadata, handleGithubOperation } from './operations';

function invalidRequest(operationId: string, message: string): ForgeResponse {
  return { operationId, ok: false, error: { kind: 'invalid_request', message } };
}

export async function runGithubPlugin(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === 'metadata') {
    console.log(JSON.stringify(githubPluginMetadata));
    return 0;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.stdin.text()) as unknown;
  } catch {
    console.log(
      JSON.stringify(invalidRequest('invalid', 'stdin must contain one UTF-8 JSON request'))
    );
    return 1;
  }
  const operationId =
    typeof raw === 'object' &&
    raw !== null &&
    'operationId' in raw &&
    typeof raw.operationId === 'string' &&
    raw.operationId !== ''
      ? raw.operationId
      : 'invalid';
  const request = forgeRequestSchema.safeParse(raw);
  if (!request.success) {
    console.log(
      JSON.stringify(invalidRequest(operationId, 'stdin does not match the forge request schema'))
    );
    return 1;
  }
  if (args.length !== 2 || args[0] !== 'op' || args[1] !== request.data.op) {
    console.log(
      JSON.stringify(
        invalidRequest(operationId, `expected executable arguments: op ${request.data.op}`)
      )
    );
    return 1;
  }

  const response = await handleGithubOperation(request.data, {
    token: process.env.ARCHON_FORGE_TOKEN,
  });
  console.log(JSON.stringify(response));
  return response.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runGithubPlugin(process.argv.slice(2));
