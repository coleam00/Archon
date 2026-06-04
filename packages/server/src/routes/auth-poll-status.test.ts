import { describe, test, expect } from 'bun:test';
import { mapDeviceFlowErrorToPollStatus } from './auth-poll-status';

describe('mapDeviceFlowErrorToPollStatus', () => {
  test('maps expired_token to expired (UI prompts a restart)', () => {
    expect(mapDeviceFlowErrorToPollStatus('expired_token')).toBe('expired');
  });

  test('maps access_denied to denied', () => {
    expect(mapDeviceFlowErrorToPollStatus('access_denied')).toBe('denied');
  });

  test('maps unknown/other codes to a generic error', () => {
    expect(mapDeviceFlowErrorToPollStatus('unsupported_grant_type')).toBe('error');
    expect(mapDeviceFlowErrorToPollStatus('incorrect_client_credentials')).toBe('error');
    expect(mapDeviceFlowErrorToPollStatus('')).toBe('error');
  });
});
