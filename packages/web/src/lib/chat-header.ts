export function resolveChatHeaderPath(
  conversationCwd: string | null | undefined,
  cwdOverride: string | null | undefined
): string | undefined {
  const override = cwdOverride?.trim();
  if (override) return override;

  const cwd = conversationCwd?.trim();
  return cwd || undefined;
}
