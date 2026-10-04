export interface PlatformPolicy {
  readonly id: string;
  readonly workspaceRetention: 'age-based' | 'retain';
  readonly streaming?: {
    readonly defaultMode: 'stream' | 'batch';
    readonly envVar: string;
  };
}
