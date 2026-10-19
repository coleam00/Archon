/**
 * Archon path resolution utilities
 *
 * Directory structure:
 * ~/.archon/                              # User-level (ARCHON_HOME)
 * ├── workspaces/<project>/              # Project-centric layout, where <project> is
 * │   │                                  #   <owner>/<repo>   registered repo with a remote
 * │   │                                  #   _local/<basename>  no-remote local git repo
 * │   │                                  #   _folder/<slug>     folder project (runs in place)
 * │   │                                  #   @cwd/<basename>-<digest>    unregistered working dir
 * │   ├── source/                        # Clone or symlink → local path (repo kinds only)
 * │   ├── worktrees/                     # Git worktrees for this project (repo kinds only)
 * │   ├── artifacts/runs/{workflow-id}/  # Workflow artifacts (NEVER in git)
 * │   ├── logs/{workflow-id}.jsonl       # Workflow execution logs
 * │   └── state/                         # $STATE_DIR — cross-run state, shared per project
 * ├── temp/                              # Ephemeral scratch (per-simulation dry-run dirs)
 * ├── worktrees/                         # Legacy global worktrees (for repos not in workspaces/)
 * ├── install.json                       # Last compiled CLI invoked
 * └── config.yaml                        # Global config
 *
 * `resolveProjectStorageKey` + `getProjectStoragePaths` are the single source of
 * truth for that mapping; every consumer resolves through them.
 *
 * Each area has its own module. This file re-exports all of them for importers of
 * the `@archon/paths/archon-paths` subpath, which bypasses the package barrel.
 *
 * For Docker: /.archon/
 */

export * from './home-paths';
export * from './project-paths';
export * from './run-paths';
export * from './source-tree-paths';
export * from './markdown-discovery';
