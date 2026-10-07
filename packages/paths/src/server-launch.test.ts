import { expect, test } from 'bun:test';
import { parseServerLaunchArgv, serverLaunchArgv, serverReleaseAsset } from './server-launch';

test.each([
  ['bun-darwin-x64', 'archon-server-darwin-x64'],
  ['bun-darwin-arm64', 'archon-server-darwin-arm64'],
  ['bun-linux-x64', 'archon-server-linux-x64'],
  ['bun-linux-arm64', 'archon-server-linux-arm64'],
  ['bun-windows-x64', 'archon-server-windows-x64.exe'],
  ['bun-windows-arm64', 'archon-server-windows-arm64.exe'],
])('server asset for %s is %s', (target, asset) => {
  expect(serverReleaseAsset(target)).toBe(asset);
});

test('unsupported targets fail clearly', () => {
  expect(() => serverReleaseAsset('bun-freebsd-x64')).toThrow('Unsupported server target');
});

test('launch arguments round-trip paths with spaces and optional overrides', () => {
  const options = { cliVersion: 'dev', port: 8080, webDistPath: '/web dist' };
  expect(parseServerLaunchArgv(serverLaunchArgv(options))).toEqual(options);
  expect(parseServerLaunchArgv(serverLaunchArgv({ cliVersion: 'dev' }))).toEqual({
    cliVersion: 'dev',
    port: undefined,
    webDistPath: undefined,
  });
});

test.each(['0', '65536', '1.5', 'invalid', ''])('rejects invalid port %s', port => {
  expect(() => parseServerLaunchArgv(['--cli-version', 'dev', '--port', port])).toThrow(
    '--port must be an integer between 1 and 65535'
  );
});

test.each(
  [[], ['--cli-version', ''], ['--cli-version', 'dev', '--unknown'], ['positional']].map(args => ({
    args,
  }))
)('rejects missing contracts and unsupported arguments: %j', ({ args }) => {
  expect(() => parseServerLaunchArgv(args)).toThrow();
});
