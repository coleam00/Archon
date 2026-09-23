import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubWebhookSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
