/**
 * A stopped Pi turn on a real agent loop: Pi's faux model streams a reply slowly, the
 * caller stops it after the first reply block reached them, and the next turn on the
 * reopened session must see both the stopped request and the reply the caller already saw.
 *
 * Runs in its own `bun test` process (package.json testGroups): the provider unit tests
 * mock the Pi SDK process-wide through provider-test-fixture.ts.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempTree } from '@archon/paths/test-utils';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

import { bridgeSession } from './event-bridge';

const scratch = mkdtempSync(join(tmpdir(), 'archon-pi-stop-resume-'));
afterAll(async () => {
  await removeTempTree(scratch);
});

// Slow enough that the second block is still streaming when the caller stops.
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1' }], tokensPerSecond: 50 });
const modelRuntime = await ModelRuntime.create({
  authPath: join(scratch, 'auth.json'),
  modelsPath: join(scratch, 'models.json'),
});
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.setRuntimeApiKey('faux', 'not-a-secret');

const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'test',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => undefined,
  reload: async () => undefined,
} as unknown as ResourceLoader;

async function openSession(sessionManager: SessionManager) {
  const { session } = await createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    noTools: 'builtin',
  });
  return session;
}

test('a stopped turn leaves the request and the reply already shown in the resumed context', async () => {
  const shownBlock = 'The first paragraph of the plan.';
  faux.setResponses([
    fauxAssistantMessage([fauxText(shownBlock), fauxText('A second paragraph. '.repeat(200))]),
  ]);
  const first = await openSession(SessionManager.create(scratch, join(scratch, 'sessions')));
  const sessionFile = first.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error('a persistent session has a file');

  const stop = new AbortController();
  const seen: string[] = [];
  await expect(
    (async () => {
      for await (const chunk of bridgeSession(first, 'Draft the plan.', stop.signal)) {
        if (chunk.type !== 'agent_message_chunk') continue;
        seen.push(chunk.text);
        stop.abort();
      }
    })()
  ).rejects.toThrow('Query aborted');
  expect(seen).toEqual([shownBlock]);

  let resumedContext: unknown;
  const answer: FauxResponseStep = context => {
    resumedContext = context.messages;
    return fauxAssistantMessage('Revised.');
  };
  faux.setResponses([answer]);
  const resumed = await openSession(SessionManager.open(sessionFile));
  for await (const _ of bridgeSession(resumed, 'Rewrite that first paragraph.')) {
    // Drain the turn.
  }

  const transcript = JSON.stringify(resumedContext);
  expect(transcript).toContain('Draft the plan.');
  expect(transcript).toContain(shownBlock);
  expect(transcript).toContain('Rewrite that first paragraph.');
});
