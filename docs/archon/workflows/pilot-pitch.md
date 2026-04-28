# Pilot Pitch: Making AI Coding Real Enough To Judge

## The Short Version

AI coding is already here. The question is not whether we should use it. The question is whether we can use it in a way that is disciplined enough to trust.

Right now, most AI coding experiments fail in one of two ways:

- They are too casual, so nobody can tell whether the result was repeatable.
- They are too hyped, so success gets declared before the team understands the tradeoffs.

This pilot is designed to avoid both traps.

We are not proposing that AI replaces product judgment, design craft, engineering responsibility, QA rigor, security review, operational ownership, documentation, or customer empathy.

We are proposing a controlled experiment: encode our real delivery process as deterministic Archon workflows, run actual work through it, and learn where AI helps, where it fails, and where our own process needs to become clearer.

The goal is not blind automation. The goal is better evidence.

## Why This Matters Now

Every product team is being asked some version of the same question:

> What should we actually do with AI coding?

The easy answers are not good enough.

"Let everyone use whatever assistant they like" gives us speed in pockets, but no shared learning. The work disappears into individual chats and local branches. We cannot inspect the process, compare runs, or improve it as a team.

"Automate everything" is worse. It treats software delivery as if the hard part is typing code. It ignores the real work: deciding what matters, understanding users, designing the right experience, managing risk, validating behavior, preparing customers, and operating production.

The useful path is narrower and more interesting:

> Use AI where it helps, but put it inside a process we own.

That is what this Archon pilot is about.

## The Problem With AI Coding Today

Modern coding agents can be impressive. They can read a codebase, draft a plan, edit files, run tests, summarize a PR, and help with review. But a capable agent is not the same thing as a reliable delivery system.

Without a process around the agent:

- One run investigates deeply; another jumps straight to editing.
- One run writes tests; another forgets.
- One run notices docs impact; another ignores it.
- One run flags a security risk; another treats it as ordinary code.
- One run creates a useful summary; another leaves reviewers to reconstruct intent.

That inconsistency makes it hard to trust the output. It also makes it hard to learn. If every attempt is shaped by a different prompt, model, context window, and human operator, then we cannot tell what worked.

Was the AI good? Was the prompt good? Was the task too vague? Was the PRD missing something? Did QA find a product ambiguity? Did security get involved too late? Did the model hallucinate, or did we fail to provide enough context?

Most teams cannot answer those questions because the process is not visible.

## The Bet

Our bet is simple:

> AI coding becomes more useful when the team defines the workflow, the artifacts, and the approval gates.

Archon gives us a way to do that.

Instead of asking an agent to "build the feature" and hoping it follows good habits, we define the delivery path:

1. Product clarifies the request and writes a PRD.
2. Design turns the PRD into UX handoff.
3. Development builds in an isolated worktree.
4. Security reviews triggered risk areas.
5. QA creates and executes a test plan.
6. Documentation drafts customer-facing updates.
7. DevOps checks deployment and rollback readiness.
8. Professional Services prepares customer rollout notes.

AI can help at each step, but it does not own the process. We do.

## What Makes This Different

This is not "just use Claude Code," "just use Codex," or "just assign it to Copilot."

Those tools are agents. Archon is the harness around agents.

The distinction matters:

- The agent decides how to solve a task.
- The workflow defines what steps must happen.
- The artifact records what was decided.
- The approval gate keeps human judgment in the loop.

The pilot gives us a shared way to compare work, inspect failure modes, and improve the process.

If AI helps, we should be able to see where. If it wastes time, we should be able to see that too.

## What We Are Actually Piloting

We are piloting a cross-functional workflow system for product delivery.

The initial workflow set covers:

- Product intake and PRD creation
- Design brief and UX handoff
- Development plan to PR
- Security risk gate
- QA validation
- Docs impact and release notes
- DevOps release readiness
- Professional Services customer readiness

Each workflow produces artifacts. These artifacts become the handoff between roles.

For example:

- Product produces `prd.md`.
- Design produces `design-brief.md`.
- Development produces `implementation-report.md`.
- Security produces `security-signoff.md`.
- QA produces `validation-report.md`.
- Docs produces `release-notes.md`.
- DevOps produces `rollback-plan.md`.
- Services produces `customer-impact.md`.

The important thing is not the filenames. The important thing is that the work becomes inspectable.

## What We Hope To Learn

This pilot should help us answer practical questions:

- Does AI reduce time spent on first drafts, research, review, or handoff?
- Does a deterministic workflow reduce missed steps?
- Are generated artifacts useful to the next function, or just extra paperwork?
- Which work should remain human-led?
- Which approvals are essential, and which are ceremony?
- Where does AI introduce risk?
- Where does our current process rely on undocumented tribal knowledge?
- What classes of work are good candidates for AI-assisted delivery?
- What classes of work are bad candidates?

The most valuable outcome may not be faster coding. It may be a clearer picture of our actual delivery process.

## What Success Looks Like

This pilot succeeds if we can make evidence-based decisions about AI coding.

Success does not require every workflow to be perfect. It does not require AI to complete every task. It does not require us to keep every template we create.

Success means:

- We run at least five real tickets through the workflow set.
- We produce artifacts that other functions can actually use.
- We identify where AI saves time and where it creates review burden.
- We catch at least one missed-risk or missed-handoff pattern earlier than usual.
- We improve the workflows based on real usage.
- We can say, with evidence, what is real and what is hype.

## What Failure Looks Like

Failure is also useful if we learn from it.

The pilot fails if:

- The workflows generate documents nobody reads.
- Approval gates become performative.
- The team spends more time managing the system than doing useful work.
- AI output creates more review burden than leverage.
- The artifacts hide uncertainty instead of surfacing it.
- People treat the workflow as a substitute for judgment.

If that happens, we should not force adoption. We should shrink, simplify, or stop.

That is part of the experiment.

## Why The Whole Team Should Be Involved

AI coding is often framed as an engineering productivity tool. That framing is too small.

Software delivery is cross-functional. Code is only one part of the value chain.

Product decides what matters. Design shapes the experience. Engineering builds the system. QA protects behavior. Security protects trust. Docs make the change understandable. DevOps makes it shippable and recoverable. Professional Services makes it real for customers.

If AI only accelerates coding while weakening the surrounding handoffs, we have not improved delivery. We have just moved ambiguity faster.

This pilot asks a better question:

> Can AI help the entire product team produce clearer, safer, more reviewable work?

## What This Asks From Each Function

Product should challenge whether the PRD workflow clarifies real decisions or just creates polished filler.

Design should challenge whether UX handoff artifacts are specific enough to build and test.

Development should challenge whether implementation workflows improve focus, isolation, validation, and PR quality.

QA should challenge whether test plans are grounded in actual risk and behavior.

Security should challenge whether the security gate catches meaningful risk without becoming a blanket blocker.

Docs should challenge whether generated release notes and help updates match real customer language.

DevOps should challenge whether deployment and rollback plans are operationally useful.

Professional Services should challenge whether customer readiness artifacts would actually help in the field.

Leadership should challenge whether the whole system improves flow, evidence, and decision-making.

## The Mindset For The Pilot

We should enter this with curiosity, not credulity.

We should expect some things to work and some things to be awkward.

We should be willing to be surprised. Maybe AI is better at first drafts than final answers. Maybe it is useful for security checklists but weak at nuanced risk judgment. Maybe it helps QA think of edge cases. Maybe it writes bloated docs. Maybe it exposes that our PRDs are too vague. Maybe it shows that some approvals happen too late.

That is the point.

The pilot is not a sales demo. It is a learning system.

## How We Will Run It

We will start with a small number of real tickets.

For each ticket:

1. Start from a GitHub issue.
2. Run the relevant Archon workflow.
3. Review the generated artifact.
4. Decide whether the artifact is useful, incomplete, or wrong.
5. Continue only through the workflows that apply.
6. Link artifacts in the PR.
7. Record skipped gates as `Not needed` with a reason.
8. Capture one improvement to the workflow after the ticket.

We will not require every ticket to go through every workflow.

We will not treat AI output as authoritative.

We will not remove human approval from high-risk decisions.

## How We Will Judge It

After the pilot, we should be able to answer:

- Which workflows should we keep?
- Which workflows should be simplified?
- Which workflows should be removed?
- Which artifacts were valuable?
- Which artifacts were noise?
- Which functions got leverage?
- Which functions got burden?
- Which risks did the system catch?
- Which risks did it miss?
- What should remain a human decision?
- What should become a standard workflow?

The output of the pilot should be a decision, not a vibe.

## The Ask

Give this pilot enough real work to be meaningful.

Bring skepticism. Bring craft. Bring the parts of your job that are hard to encode. Bring the places where AI usually disappoints you. Bring the places where you think it might quietly help.

The goal is not to prove that AI coding is magic.

The goal is to learn, as a team, whether we can make AI coding useful inside a process we trust.

That is worth a pilot.

