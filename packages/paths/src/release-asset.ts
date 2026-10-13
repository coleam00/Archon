export function releaseAsset(executable: string, bunTarget: string): string {
  const match = /^bun-(darwin|linux|windows)-(x64|arm64)$/.exec(bunTarget);
  if (!match) throw new Error(`Unsupported release target: ${bunTarget}`);
  return `${executable}-${match[1]}-${match[2]}${match[1] === 'windows' ? '.exe' : ''}`;
}
