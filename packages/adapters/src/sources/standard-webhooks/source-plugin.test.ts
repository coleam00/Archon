import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import {
  webhookSourceResultSchema,
  type WebhookSourceRequest,
} from '@archon/workflows/webhook-source-plugin';
import createSource from './source-plugin';

const envName = 'ARCHON_STANDARD_WEBHOOKS_UNIT_SECRET';
const original = process.env[envName];
const secret = Buffer.from('test-key-for-standard-webhooks');
beforeEach(() => {
  process.env[envName] = 'whsec_' + secret.toString('base64');
});
afterEach(() => {
  if (original === undefined) delete process.env[envName];
  else process.env[envName] = original;
});
const binding = {
  bindingId: 'order',
  hostId: 'host',
  runAsUserId: 'operator',
  resource: 'orders',
  overlap: 'queue',
  launch: {
    cwd: resolve('test-project'),
    workflowName: 'process-order',
    inputs: { count: 0 },
    isolation: { kind: 'in-place' },
  },
  inputMapping: { count: '/order/count' },
};
const config = () => ({ version: 1, signingSecretEnv: envName, bindings: [binding] });
function signed(
  body = JSON.stringify({ order: { count: 42 } }),
  timestamp = '1791806400'
): WebhookSourceRequest {
  const id = 'order-123';
  return {
    body,
    receivedAt: '2026-10-12T12:00:00.000Z',
    headers: {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature':
        'v1,' + createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64'),
    },
  };
}
async function receive(request: WebhookSourceRequest, sourceConfig: unknown = config()) {
  const source = await createSource({ sourceInstanceId: 'orders', config: sourceConfig });
  return webhookSourceResultSchema.parse(await source.receive(request));
}
test('maps only configured inputs over literals and retains operator authority', async () => {
  const request = signed(
    JSON.stringify({
      order: { count: 42 },
      workflowName: 'evil',
      cwd: '/evil',
      runAsUserId: 'evil',
      isolation: { kind: 'worktree' },
      hostId: 'evil',
      resource: 'evil',
    })
  );
  const { inputMapping, ...intent } = binding;
  void inputMapping;
  const result = await receive(request);
  expect(result).toMatchObject({
    status: 'received',
    acceptance: {
      outcome: 'matched',
      receipt: { deliveryId: 'order-123', sourceActor: null },
      bindings: [{ ...intent, launch: { ...binding.launch, inputs: { count: 42 } } }],
    },
  });
  if (result.status !== 'received') throw Error('Expected receipt');
  const replay = await receive(request);
  expect(replay).toMatchObject({
    acceptance: {
      receipt: {
        deliveryId: result.acceptance.receipt.deliveryId,
        contentDigest: result.acceptance.receipt.contentDigest,
      },
    },
  });
});
test('missing targets reject only their binding and whole-document pointers preserve JSON values', async () => {
  const result = await receive(signed(), {
    ...config(),
    bindings: [
      { ...binding, bindingId: 'missing', inputMapping: { count: '/absent' } },
      { ...binding, inputMapping: { payload: '' } },
    ],
  });
  expect(result).toMatchObject({
    status: 'received',
    acceptance: {
      outcome: 'matched',
      evaluatedBindings: [
        {
          bindingId: 'missing',
          status: 'rejected',
          reason: "Input 'count': pointer /absent did not resolve",
        },
      ],
      bindings: [{ launch: { inputs: { count: 0, payload: { order: { count: 42 } } } } }],
    },
  });
});
test('records authenticated malformed JSON', async () => {
  expect(await receive(signed('{invalid'))).toMatchObject({
    status: 'received',
    acceptance: { outcome: 'malformed', reason: 'invalid_json', bindings: [] },
  });
});
test.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
  'rejects missing %s without a receipt',
  async header => {
    const request = signed();
    delete request.headers[header];
    expect(await receive(request)).toEqual({ status: 'rejected', reason: 'unauthenticated' });
  }
);
test.each([
  '1791806099',
  '1791806701',
  '1791806400suffix',
  '1791806400.0',
  '+1791806400',
  '1791806400, 1791806400',
])('rejects stale or non-integer timestamp %s', async timestamp => {
  expect(await receive(signed(undefined, timestamp))).toEqual({
    status: 'rejected',
    reason: 'unauthenticated',
  });
});
test.each(['1791806100', '1791806700'])('accepts the 300-second boundary %s', async timestamp => {
  expect(await receive(signed(undefined, timestamp))).toMatchObject({ status: 'received' });
});
test('rejects tampering, wrong keys and inexact signature entries', async () => {
  const request = signed();
  expect(await receive({ ...request, body: request.body.replace('42', '43') })).toEqual({
    status: 'rejected',
    reason: 'unauthenticated',
  });
  process.env[envName] = 'whsec_' + Buffer.from('wrong-key').toString('base64');
  expect(await receive(request)).toEqual({ status: 'rejected', reason: 'unauthenticated' });
  process.env[envName] = 'whsec_' + secret.toString('base64');
  for (const signature of [
    request.headers['webhook-signature'] + ',suffix',
    'v1a,' + request.headers['webhook-signature'].slice(3),
    'v1,bad',
    'v1,' + request.headers['webhook-signature'].slice(3).replace(/=$/, ''),
  ]) {
    expect(
      await receive({ ...request, headers: { ...request.headers, 'webhook-signature': signature } })
    ).toEqual({ status: 'rejected', reason: 'unauthenticated' });
  }
});
test('accepts either rotated v1 signature', async () => {
  for (const first of [true, false]) {
    const request = signed();
    request.headers['webhook-signature'] = first
      ? request.headers['webhook-signature'] + ' v1,bad'
      : 'v1,bad ' + request.headers['webhook-signature'];
    expect(await receive(request)).toMatchObject({ status: 'received' });
  }
});
test.each([undefined, '', 'plain-secret', 'whsec_', 'whsec_%%%=', 'whsec_YQ', 'whsec_YR=='])(
  'fails boot for invalid secret %s',
  async secretValue => {
    if (secretValue === undefined) delete process.env[envName];
    else process.env[envName] = secretValue;
    expect(() => createSource({ sourceInstanceId: 'orders', config: config() })).toThrow(
      'signing secret'
    );
  }
);
test('fails boot for invalid configuration', () => {
  for (const invalid of [
    { ...config(), unexpected: true },
    { ...config(), bindings: [binding, binding] },
    { ...config(), bindings: [{ ...binding, launch: { ...binding.launch, cwd: 'relative' } }] },
    { ...config(), bindings: [{ ...binding, inputMapping: { count: '/~2' } }] },
  ])
    expect(() => createSource({ sourceInstanceId: 'orders', config: invalid })).toThrow(
      'configuration'
    );
});

// Published vector: standard-webhooks/standard-webhooks, libraries/javascript/src/webhook.test.ts.
test('verifies the published Standard Webhooks signing vector', async () => {
  process.env[envName] = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  expect(
    await receive(
      {
        body: '{"test": 2432232314}',
        receivedAt: new Date(1614265330 * 1000).toISOString(),
        headers: {
          'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
          'webhook-timestamp': '1614265330',
          'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
        },
      },
      { ...config(), bindings: [] }
    )
  ).toMatchObject({ status: 'received' });
});
