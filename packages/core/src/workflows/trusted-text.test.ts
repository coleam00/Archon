import { describe, expect, test } from 'bun:test';
import type { ForgeRequest, ForgeResponse } from '@archon/forge';
import { trustedTextDigest } from '@archon/forge';
import type { Codebase } from '../schemas/codebase';
import { CoreTrustedTextHost, TrustedTextRefusedError } from './trusted-text';
import type { TrustedTextRunMetadata } from '@archon/workflows/trusted-text';

const maintainer = { host: 'github.com', id: '1', login: 'alice' };
const outsider = { host: 'github.com', id: '2', login: 'outside' };
const requirement = {
  subject: {
    kind: 'issue' as const,
    ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 7 },
  },
  maintainersPath: '.archon/maintainers.json',
  input: 'trusted_item',
};
const codebase: Codebase = {
  id: 'codebase',
  name: 'repo',
  repository_url: 'https://github.com/owner/repo',
  default_cwd: '/repo',
  default_branch: 'main',
  ai_assistant_type: null,
  kind: 'repo',
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
};

function evidence(title = 'Title', body = 'Body', maintainers = ['alice']) {
  return {
    ...requirement,
    title,
    body,
    contentDigest: trustedTextDigest(title, body),
    author: outsider,
    policy: {
      head: 'a'.repeat(40),
      digest: 'b'.repeat(64),
      maintainers,
      maintainersPath: requirement.maintainersPath,
    },
  };
}

function harness() {
  let current = evidence();
  let acceptor = maintainer;
  const accepted = new Map<string, TrustedTextRunMetadata>();
  const requests: ForgeRequest[] = [];
  const dispatch = async (request: ForgeRequest) => {
    requests.push(request);
    if (request.op === 'workitem.accept') {
      const matches = current.contentDigest === request.expectedContentDigest;
      return {
        response: (matches
          ? {
              operationId: request.operationId,
              ok: true,
              result: {
                op: 'workitem.accept',
                value: { ...current, acceptedBy: acceptor, scope: request.scope },
              },
            }
          : {
              operationId: request.operationId,
              ok: false,
              error: { kind: 'conflict', message: 'stale' },
            }) as ForgeResponse,
      };
    }
    if (request.op !== 'workitem.trust') throw new Error('unexpected operation');
    return {
      response: {
        operationId: request.operationId,
        ok: true,
        result: { op: 'workitem.trust', value: current },
      } as ForgeResponse,
    };
  };
  const host = new CoreTrustedTextHost(
    {
      codebases: { getCodebase: async () => codebase },
      trustedText: {
        declareRequirement: async () => undefined,
        requirementForItem: async () => null,
        readAcceptedItem: async () => accepted.values().next().value ?? null,
        readAccepted: async (projectKey, itemKey) =>
          accepted.get(`${projectKey}:${itemKey}`) ?? null,
        writeAccepted: async (projectKey, itemKey, snapshot) => {
          accepted.set(`${projectKey}:${itemKey}`, snapshot);
        },
      },
    },
    dispatch
  );
  return {
    host,
    accepted,
    requests,
    set: (value: ReturnType<typeof evidence>) => {
      current = value;
    },
    setAcceptor: (value: typeof maintainer) => {
      acceptor = value;
    },
  };
}

function acceptance(): Extract<ForgeRequest, { op: 'workitem.accept' }> {
  return {
    operationId: 'accept',
    op: 'workitem.accept',
    subject: requirement.subject,
    maintainersPath: requirement.maintainersPath,
    expectedContentDigest: trustedTextDigest('Title', 'Body'),
    scope: {
      codebaseId: codebase.id,
      itemKey: 'issue-7',
      input: requirement.input,
    },
  };
}

describe('CoreTrustedTextHost', () => {
  test('item authorization cannot reuse an acceptance for another subject with identical text', async () => {
    const h = harness();
    await h.host.accept(acceptance());
    for (const changed of [
      {
        ...requirement,
        subject: { ...requirement.subject, ref: { ...requirement.subject.ref, number: 8 } },
      },
      { ...requirement, input: 'other_input' },
      { ...requirement, maintainersPath: '.archon/other-maintainers.json' },
    ]) {
      await expect(h.host.authorizeItem(changed, 'same-item')).rejects.toThrow(
        'acceptance_requirement_changed'
      );
    }
  });

  test('authorization and recheck require the original acceptor and author to remain trusted', async () => {
    const h = harness();
    const accepted = await h.host.accept(acceptance());
    h.set(evidence('Title', 'Body', []));
    await expect(h.host.authorize(requirement, { codebase, itemKey: 'issue-7' })).rejects.toThrow(
      'waiting_acceptance'
    );
    await expect(h.host.recheck(accepted)).rejects.toThrow('maintainer_removed');

    h.set({ ...evidence(), author: maintainer });
    const authored = await h.host.authorize(requirement, { codebase, itemKey: 'issue-7' });
    expect(authored.acceptedBy).toBeUndefined();
    h.set(evidence());
    await expect(h.host.recheck(authored)).rejects.toThrow('author_no_longer_trusted');
  });
  test('outside text waits for exact acceptance and a trusted author needs none', async () => {
    const h = harness();
    await expect(h.host.authorize(requirement, { codebase, itemKey: 'issue-7' })).rejects.toThrow(
      'waiting_acceptance'
    );
    const snapshot = await h.host.accept(acceptance());
    expect(h.requests.at(-1)).not.toHaveProperty('title');
    expect(h.requests.at(-1)).not.toHaveProperty('policy');
    await expect(h.host.authorize(requirement, { codebase, itemKey: 'issue-7' })).resolves.toEqual(
      snapshot
    );
    await expect(h.host.authorize(requirement, { codebase, itemKey: 'issue-8' })).rejects.toThrow(
      'waiting_acceptance'
    );
    h.set({ ...evidence(), author: maintainer });
    const trusted = await h.host.authorize(requirement, { codebase, itemKey: 'issue-8' });
    expect(trusted.acceptedBy).toBeUndefined();
  });

  test('queued and later runs reject every exact-text or maintainer change', async () => {
    const h = harness();
    const snapshot = await h.host.accept(acceptance());
    for (const changed of [
      evidence('Changed', 'Body'),
      evidence('Title', 'Body\n'),
      evidence('Title', 'Bodý'),
      evidence('Title', 'Body', []),
    ]) {
      h.set(changed);
      await expect(h.host.recheck(snapshot)).rejects.toBeInstanceOf(TrustedTextRefusedError);
    }
  });

  test('acceptance rejects forged actors and concurrent stale evidence cannot authorize new text', async () => {
    const h = harness();
    h.setAcceptor(outsider);
    await expect(h.host.accept(acceptance())).rejects.toThrow('untrusted_accept_refused');
    h.setAcceptor(maintainer);
    const first = await h.host.accept(acceptance());
    h.set(evidence('Second', 'Body'));
    await expect(h.host.recheck(first)).rejects.toThrow('waiting_acceptance');
    await expect(h.host.authorize(requirement, { codebase, itemKey: 'issue-7' })).rejects.toThrow(
      'waiting_acceptance'
    );
    expect(JSON.stringify([...h.accepted.values()])).not.toContain('Second');
  });

  test('acceptance reads current evidence instead of trusting a stale caller snapshot', async () => {
    const h = harness();
    const request = acceptance();
    h.set(evidence('Changed before accept', 'Body'));
    await expect(h.host.accept(request)).rejects.toThrow('content_changed_before_acceptance');
    expect(h.accepted.size).toBe(0);
    expect(JSON.stringify([...h.accepted.values()])).not.toContain('Changed before accept');
  });

  test('digest is sensitive to field boundaries, CRLF and Unicode', () => {
    const digest = trustedTextDigest('Title', 'Body\r\n');
    expect(digest).not.toBe(trustedTextDigest('Title', 'Body\n'));
    expect(digest).not.toBe(trustedTextDigest('TitleBody', '\r\n'));
    expect(digest).not.toBe(trustedTextDigest('Title', 'Body\u0301\r\n'));
  });
});
