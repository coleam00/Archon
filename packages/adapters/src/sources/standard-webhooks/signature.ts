import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookSourceRequest } from '@archon/workflows/webhook-source-plugin';

export function decodeSigningSecret(secret: string | undefined): Buffer {
  const encoded = secret?.startsWith('whsec_') ? secret.slice(6) : '';
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encoded)
    throw new Error('Standard Webhooks signing secret must be whsec_ followed by valid base64');
  return decoded;
}

export function verifySignature(request: WebhookSourceRequest, secret: Buffer): boolean {
  const id = request.headers['webhook-id'];
  const timestamp = request.headers['webhook-timestamp'];
  const signatures = request.headers['webhook-signature'];
  if (!id || !timestamp || !signatures || !/^[0-9]+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  const received = Date.parse(request.receivedAt) / 1000;
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isFinite(received) ||
    Math.abs(received - seconds) > 300
  )
    return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${id}.${timestamp}.${request.body}`).digest('base64')
  );
  return signatures.split(' ').some(entry => {
    if (!entry.startsWith('v1,')) return false;
    const candidate = Buffer.from(entry.slice(3));
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}
