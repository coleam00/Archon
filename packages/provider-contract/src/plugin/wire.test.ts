import { expect, test } from 'bun:test';
import { providerStopReasonSchema } from '../result';
import { checkAcp } from './fixtures/acp';
import {
  acpStopReason,
  providerPluginDescriptorSchema,
  providerSessionRequestSchema,
} from './wire';
import { descriptor } from './fixtures/provider';

test('descriptors refuse capabilities the wire cannot carry', () => {
  expect(() =>
    providerPluginDescriptorSchema.parse({
      ...descriptor,
      capabilities: { ...descriptor.capabilities, nativeTools: true },
    })
  ).toThrow('nativeTools');
  expect(() =>
    providerPluginDescriptorSchema.parse({ ...descriptor, credentials: { kind: 'dynamic' } })
  ).toThrow('kind');
  expect(() => providerPluginDescriptorSchema.parse({ ...descriptor, protocol: 2 })).toThrow(
    'protocol'
  );
  expect(() =>
    providerPluginDescriptorSchema.parse({
      ...descriptor,
      credentials: {
        kind: 'static',
        specs: [{ vendor: 'vendor', displayName: 'Vendor', kinds: [] }],
      },
    })
  ).toThrow('kinds');
});

test('session requests reject non-data values and host-owned fields', () => {
  expect(() =>
    providerSessionRequestSchema.parse({ prompt: '', cwd: '/', env: { KEY: 'secret' } })
  ).toThrow('env');
  expect(() =>
    providerSessionRequestSchema.parse({ prompt: '', cwd: '/', nodeConfig: { callback: () => {} } })
  ).toThrow();
});

test('every stop reason uses ACP v1 vocabulary; missing reasons only affect acknowledgement', () => {
  for (const reason of [...providerStopReasonSchema.options, undefined]) {
    checkAcp('PromptResponse', { stopReason: acpStopReason(reason, false) });
  }
  expect(acpStopReason('end_turn', true)).toBe('cancelled');
});
