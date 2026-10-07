# Bind the delivered PR

Delivery output: $INPUTS.delivery
Read this run's artifacts in `$ARTIFACTS_DIR`: `triage.md`, `implementation.md`, the
`review/` reports and `validation.md`. They are all there; do not search the
filesystem or any other directory for them. Resolve the PR with gh on this checkout's
existing branch. Do not parse delivery prose as a success token. Require the PR's
actual same-repository head to equal git HEAD, and require completed independent
review and validation evidence from this run. Never open another PR or switch
branches. Return delivered=false when triage declined work, delivery produced no PR,
or identity/evidence is unclear. Otherwise return delivered=true, prs=[the verified
URL], and head=the exact commit SHA.
