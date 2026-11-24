# Propose policy

This is the SDLC pack's default for how a change is proposed as a pull request. A
project adds to it with its own `.archon/sdlc/policy/propose.md`: the builder reads this
default first and the project's file after it, and where the two conflict, the
project's line wins.

## The target

- The pull request opens against the repository this work is proposed to, which in a
  fork setup is the upstream the fork was made from, not the fork. Resolve it from the
  checkout's remotes (`git remote -v`) and name it by its canonical forge identity, host
  plus `owner/repo`, with transport syntax, credentials and a trailing `.git` stripped.
  Never persist or print a credential-bearing raw remote.
- The base branch is `$BASE_BRANCH`: the branch this run was cut from, which is the
  item's landing branch when it has one. Use it for every diff and as the pull
  request's base.
- One change has one pull request. Before opening one, look for the open pull request
  whose head is this branch (`pr.view` with `{"selector":{"kind":"head",…}}`), and
  continue it when it exists.

## The description

- Find the repository's pull request template (`.github/pull_request_template.md` and
  its supported variants). Use it; fill every applicable section with concrete
  information and delete instructional comments. No template: problem first, then the
  solution focused on behavior, then the validation that actually ran.
- When the plan this work delivers lists contract additions, flag each one in the body
  as a contract addition: what it adds to the shipped surface, and why every existing
  value keeps its meaning, so the reviewer can check that claim.
- Title: concise, human, the meaningful outcome, never an implementation inventory.
- Link the issue with a non-closing reference (`Refs #N`), never a closing keyword,
  even where the template offers a `Closes #` line: no review has judged this work yet.
  The host and land stages pick the final keyword from the review's contract coverage
  and the issue's dated rulings. When the issue's body has a `Delivered together`
  section, link each issue it lists the same way. Never infer linkage from a bare
  number.
- Content the work requires in the description, such as evidence, measurements or an
  operator check the review deferred, goes in it complete, not summarized.
- Never add AI attribution, generated-by footers, or robot emoji.
- Write the body to a file under `$ARTIFACTS_DIR` with your file-writing tool, never
  inside the repository, and pass it with `--data-file`, so the description never
  reaches a command line. Read it back before you pass it.

## Draft

A pull request opens as a draft. The host stage takes it out of draft once the review
approved it, which is what starts CI in many repositories.
