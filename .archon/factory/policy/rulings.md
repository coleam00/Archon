# Rulings

Answers Archon's maintainers have already given. A stage reads them before it leaves an ask, and a question one of them answers is settled.

- **A sentence in the reference or a guide gets no test.** A reviewer reads it against the behaviour. A test of prose guards wording, not behaviour. (2026-11-16, asked on issues 5732, 5734 and 5738.)
- **A clean-up that must stay clean gets no new tool to keep it so.** Removing an unused export, a dead file or a duplicate is a one-time change; a repository-wide check for it is a separate decision with its own issue. (2026-11-16, issue 5732.) Rests on `AGENTS.md`, "Prefer the smallest truthful system".
- **A gap that was there before the change is noticed, not returned.** When the base commit has the same fault, report it for the project and do not hold the change for it. (2026-11-15, issues 5696 and 5699.)
- **A check that needs a live account, a real forge write outside the change, or a maintainer's authorization is an operator check.** Name it in the pull request; it does not stop a plan, a build or a review. Rests on `.archon/sdlc/policy/rulings.md`.
