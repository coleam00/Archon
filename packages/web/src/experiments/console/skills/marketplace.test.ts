import { describe, test, expect } from 'bun:test';
import { httpErrorToMessage, type MarketplaceSubmitParams } from './marketplace';
import { HttpError } from '../lib/http';

describe('httpErrorToMessage', () => {
  test('401 -> sign-in message', () => {
    const err = new HttpError(
      401,
      '/api/marketplace/submit',
      '{"error":"Authentication required"}'
    );
    expect(httpErrorToMessage(err)).toBe('Sign in to submit to the marketplace.');
  });

  test('409 -> slug-collision message', () => {
    const err = new HttpError(
      409,
      '/api/marketplace/submit',
      '{"error":"Slug \\"my-flow\\" is already registered by a different author."}'
    );
    expect(httpErrorToMessage(err)).toContain('already registered');
    expect(httpErrorToMessage(err)).toContain('different author');
  });

  test('422 -> server message verbatim (carries the actionable guidance)', () => {
    const err = new HttpError(
      422,
      '/api/marketplace/submit',
      '{"error":"No GitHub credential available. Connect GitHub in Settings, or set GITHUB_TOKEN on the server."}'
    );
    expect(httpErrorToMessage(err)).toBe(
      'No GitHub credential available. Connect GitHub in Settings, or set GITHUB_TOKEN on the server.'
    );
  });

  test('422 with an unparseable body falls back to a generic blocked message', () => {
    const err = new HttpError(422, '/api/marketplace/submit', 'not json');
    expect(httpErrorToMessage(err)).toBe('Submission blocked — see details below.');
  });

  test('500 -> generic message plus detail when parseable (the landed-bundle contract)', () => {
    const err = new HttpError(
      500,
      '/api/marketplace/submit',
      '{"error":"Marketplace submission failed after the bundle was committed","detail":"The bundle landed on owner/repo@abc123."}'
    );
    expect(httpErrorToMessage(err)).toBe(
      'Marketplace submission failed after the bundle was committed: The bundle landed on owner/repo@abc123.'
    );
  });

  test('500 with no detail falls back to the error field', () => {
    const err = new HttpError(
      500,
      '/api/marketplace/submit',
      '{"error":"Marketplace submission failed"}'
    );
    expect(httpErrorToMessage(err)).toBe('Marketplace submission failed');
  });

  test('unparseable non-422/409/401 body falls back to a generic HTTP-status message', () => {
    const err = new HttpError(500, '/api/marketplace/submit', 'not json');
    expect(httpErrorToMessage(err)).toBe('Marketplace submission failed (HTTP 500).');
  });

  test('400 (invalid cwd) falls through the generic branch', () => {
    const err = new HttpError(400, '/api/marketplace/submit', '{"error":"Invalid cwd"}');
    expect(httpErrorToMessage(err)).toBe('Invalid cwd');
  });

  test('a non-HttpError Error surfaces its own message', () => {
    expect(httpErrorToMessage(new Error('network down'))).toBe('network down');
  });

  test('a non-Error throwable falls back to a generic unknown-error message', () => {
    expect(httpErrorToMessage('boom')).toBe('Marketplace submission failed (unknown error).');
  });
});

describe('MarketplaceSubmitParams shape', () => {
  test('the attestation object requires all four booleans (compile-time contract)', () => {
    const params: MarketplaceSubmitParams = {
      workflowName: 'my-flow',
      cwd: '/repo',
      attestation: {
        noExfiltration: true,
        noDestructiveOps: true,
        rightToShare: true,
        shaReviewed: true,
      },
    };
    expect(params.attestation.noExfiltration).toBe(true);
  });
});
