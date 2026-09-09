# Deployment

`archon-deploy` rolls a running service forward to the repository's default
branch head with the project's own commands, then reads the result back.

Inputs are `deploy` and `health` (required trusted project shell commands),
`identity` (optional command printing the revision the running service was
built from) and `revision` (optional full SHA; empty resolves the remote default
branch head, and a revision that is not that head is refused).

The composition is four nodes and no agent: resolve the revision, run the deploy
command, poll the health command for up to thirty seconds, then compare the
identity read-back with the resolved revision. `deployed` is true only when all
three hold; a green exit code from the deploy command is never the verdict on
its own. The record lands in `$ARTIFACTS_DIR/deployment.md`.

Merging is not shipping. `archon-lifecycle` includes this workflow after a
successful merge when its optional deployment inputs are set, so an issue ends
as a running service and not only as a merged pull request. Standalone use:

```bash
archon workflow run archon-deploy \
  --input 'deploy=git -C /srv/app pull --ff-only origin main && systemctl restart app' \
  --input 'health=curl -fsS https://app.example/health' \
  --input 'identity=curl -fsS https://app.example/build-id'
```

The commands are fixed trusted project strings; never interpolate caller text
into them. The workflow runs them where Archon runs the workflow, so it suits a
service on the same host as the factory. Remote hosts are the project's concern
(an ssh command is still one command). No rollback is attempted: a failed health
or identity read-back reports `deployed: false` and leaves the operator to act.
