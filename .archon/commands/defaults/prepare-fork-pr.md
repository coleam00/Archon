---
description: Prepare the user's fork and branch after final approval
argument-hint: (no arguments - runs only after approval)
---

# Prepare Fork For Draft PR

## Mission

After approval is granted, prepare the GitHub fork and working branch for
`traefik/traefik`. This is the first write-enabled step in the lane.

## Inputs

- `$ARTIFACTS_DIR/selected-issue.json`
- `$ARTIFACTS_DIR/fix-preview.json`
- current git worktree

## Required work

1. Ensure the authenticated user has a fork of `traefik/traefik`.
2. Configure or confirm a fork remote without disturbing existing remotes.
3. Create or reuse a branch named for the selected issue.
4. Record the fork repository, branch name, and compare URL inputs for later steps.

## Required artifacts

Write `$ARTIFACTS_DIR/pr-preview.json` with:

```json
{
  "fork_repo": "",
  "branch_name": "",
  "draft_pr_title": "",
  "draft_pr_body": "",
  "compare_url": "",
  "publish_status": "prepared"
}
```

Write `$ARTIFACTS_DIR/implementation-summary.json` with at least:

```json
{
  "branch_name": "",
  "changed_files": [],
  "tests_added": [],
  "tests_modified": [],
  "implementation_notes": []
}
```

## Output

End with a one-paragraph preparation summary and the artifact paths only.
