import type { paths } from '@/lib/api.generated';
type CreateBody = NonNullable<
  paths['/api/conversations']['post']['requestBody']
>['content']['application/json'];
type LaunchBody =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['application/json'];

export interface StartRunArgs {
  projectId: NonNullable<CreateBody['codebaseId']>;
  workflow: paths['/api/workflows/{name}/run']['post']['parameters']['path']['name'];
  message: LaunchBody['message'];
  files?: File[];
  /**
   * Values for the workflow's declared `inputs:` (#2554), keyed by input name.
   * Omitted names take their declared default; a missing required input is refused by
   * the server before any worktree, clone, or AI cost.
   */
  inputs?: NonNullable<LaunchBody['inputs']>;
  tiers?: NonNullable<LaunchBody['tiers']>;
  aliases?: NonNullable<LaunchBody['aliases']>;
}
