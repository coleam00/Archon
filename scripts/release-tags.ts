export function isFinalReleaseTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}
