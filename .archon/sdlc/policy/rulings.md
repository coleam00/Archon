# Rulings

Archon's rulings: answers its maintainers have already given. Plan and review read
them before they stop for a person, and a question one of them answers is settled.

- **Live checks are operator checks.** A check that needs a live Slack, Telegram,
  Discord or GitHub App install, a forge write outside the run's branch and pull
  request (a disposable draft pull request, a label or comment on another item), a
  provider account's credentials, or a maintainer's authorization is named in the pull
  request body as an operator check. It never stops a plan or a review.
- **Packs own policy.** Who answers a pause, and how work is admitted, routed or
  merged, belong in a pack's policy documents or the user's workflows, never the
  engine ([`.archon/direction.md`](../../direction.md) §user-owns-policy). A plan that
  needs such a policy for a new forge or source writes it as pack policy.
- **No compatibility path without an implementer.** An internal interface with no
  implementation outside this repository keeps no source-compatibility path
  ([`AGENTS.md`](../../../AGENTS.md): "Do not add configuration, interfaces, lifecycle
  states, compatibility paths, or guards without a current requirement").
- **Model and provider choice is user configuration.** Tiers, aliases and provider
  configuration choose the model a node runs on; a pack file, a node field or a plan
  never does ([`AGENTS.md`](../../../AGENTS.md): "Provider capabilities normally belong
  in provider config, tiers, or aliases").
- **Agent judgment is checked by its outcome.** Ruled 2026-10-20. Agent judgment in a
  pack prompt is evaluated by its outcome
  ([`CONSTITUTION.md`](../../workflows/sdlc/CONSTITUTION.md) §13). A review does not
  require a pack fixture or test that pins which decision a prompt makes.
