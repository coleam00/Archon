# Slack Scoping Questions Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the first-iteration spec scoping questions in `archon-slack-feature-to-review-app` from free-text bullets into a Slack modal form with typed inputs, then feed submitted answers back into `$LOOP_USER_INPUT` as deterministic text.

**Architecture:** Keep workflow-engine contracts unchanged. The workflow prompt emits a fenced `archon-questions` schema block on the first `spec` loop iteration, and the Slack adapter detects that block during `interactiveGate` rendering. If valid, it renders an "Answer questions" button that opens a modal; on submit, answers are flattened into labeled text and dispatched as a synthetic Slack message through the existing message pipeline.

**Tech Stack:** Bun + TypeScript, Slack Bolt adapter (`@slack/bolt`), existing workflow YAML loop prompting, Bun test.

**Related spec:** `.claude/archon/specs/2026-04-20-slack-scoping-questions-form.spec.md`

---

## File Structure

- Modify: `.archon/workflows/defaults/archon-slack-feature-to-review-app.yaml`
  - Responsibility: Emit the `archon-questions` fenced schema on first iteration, preserving current approval semantics.
- Modify: `packages/adapters/src/chat/slack/adapter.ts`
  - Responsibility: Parse/strip question schema, render question button + modal, process modal submission, fallback to existing gate behavior on invalid schema.
- Modify: `packages/adapters/src/chat/slack/adapter.test.ts`
  - Responsibility: Validate new render paths, fallback behavior, modal submission formatting, and no-regression gate behavior.

No new packages, no DB/schema changes, no workflow-engine API changes.

---

### Task 1: Update Workflow Prompt Contract

**Files:**
- Modify: `.archon/workflows/defaults/archon-slack-feature-to-review-app.yaml` (spec node prompt block)
- Test: `bun run validate workflows archon-slack-feature-to-review-app --json`

- [ ] **Step 1: Write failing contract assertion test command**

Run:
```bash
bun run validate workflows archon-slack-feature-to-review-app --json
```

Expected now: PASS (baseline). Keep output for post-change comparison.

- [ ] **Step 2: Update first-iteration instructions to require `archon-questions` fenced YAML**

Apply this prompt delta in the `spec.loop.prompt` first-iteration section:

```yaml
## If this is the first iteration ($LOOP_USER_INPUT is empty):

1. Restate your understanding of the request in 1-2 sentences.
2. Explore the codebase briefly (CLAUDE.md, directory structure, files obviously related to the feature).
3. Ask 3-5 clarifying questions as a structured form:
   - Emit a fenced block with language tag `archon-questions`.
   - Each question must include:
     - `id` (snake_case)
     - `type` (one of: `yes_no`, `yes_no_text`, `select`, `checkboxes`, `text`)
     - `label`
   - `select` and `checkboxes` must include `options` with `{ value, label }`.
   - `required` is optional (defaults to true).
   - `yes_no_text` may include `open_text_label`.
4. End with: "Click **Answer questions** to submit your responses, and I'll draft a spec."
5. Do NOT emit the approval signal yet.
```

- [ ] **Step 3: Re-run workflow validation**

Run:
```bash
bun run validate workflows archon-slack-feature-to-review-app --json
```

Expected: PASS with valid YAML parse and no schema errors.

- [ ] **Step 4: Commit prompt-only change**

Run:
```bash
git add .archon/workflows/defaults/archon-slack-feature-to-review-app.yaml
git commit -m "feat(workflow): require structured archon-questions schema in spec loop"
```

---

### Task 2: Add Question-Schema Parse + Render Path in Slack Adapter

**Files:**
- Modify: `packages/adapters/src/chat/slack/adapter.ts`
- Test: `packages/adapters/src/chat/slack/adapter.test.ts`

- [ ] **Step 1: Add constants and schema types**

Add near existing gate constants:

```ts
const GATE_ACTION_ANSWER_QUESTIONS = 'gate_answer_questions';
const QUESTIONS_MODAL_CALLBACK = 'gate_questions_modal';
const QUESTIONS_BLOCK_REGEX = /```archon-questions\\n([\\s\\S]*?)```/m;

type QuestionType = 'yes_no' | 'yes_no_text' | 'select' | 'checkboxes' | 'text';
type QuestionOption = { value: string; label: string };
type QuestionDef = {
  id: string;
  type: QuestionType;
  label: string;
  required?: boolean;
  options?: QuestionOption[];
  open_text_label?: string;
};
```

- [ ] **Step 2: Add parse + strip helpers with fail-soft semantics**

Implement private helpers:

```ts
private extractQuestionsBlock(message: string): { cleanedMessage: string; questions: QuestionDef[] | null }
private parseQuestionsYaml(raw: string): QuestionDef[] | null
private isValidQuestionDefArray(value: unknown): value is QuestionDef[]
```

Behavior requirements:
- Strip fenced block from rendered message in all cases.
- Return `questions: null` on malformed YAML / invalid shape.
- Log `slack.questions_schema_invalid` with reason at `warn`.
- Never throw from parsing path.

- [ ] **Step 3: Branch gate rendering in `sendWithMarkdownBlock`**

Adjust `sendWithMarkdownBlock(...)`:
- Call `extractQuestionsBlock(message)` before block creation.
- Use `cleanedMessage` for markdown/text fallback.
- If `gate` exists and `questions` is valid: append one actions block from new `buildQuestionsActionsBlock(gate)`.
- Else if `gate` exists: append existing approve/request changes actions block.

Add action block builder:

```ts
private buildQuestionsActionsBlock(gate: { runId: string; nodeId: string }): SlackBlock
```

Button text: `Answer questions`; action id prefix `gate_answer_questions`.

- [ ] **Step 4: Run targeted unit tests (expected fail before Task 3 modal handlers)**

Run:
```bash
bun test packages/adapters/src/chat/slack/adapter.test.ts
```

Expected at this stage: failing tests for unimplemented action/view handlers (if tests added ahead of implementation), or PASS for existing tests + new parser/render tests.

- [ ] **Step 5: Commit parse/render scaffolding**

Run:
```bash
git add packages/adapters/src/chat/slack/adapter.ts packages/adapters/src/chat/slack/adapter.test.ts
git commit -m "feat(slack): render structured question gate when archon-questions schema is present"
```

---

### Task 3: Implement Questions Modal Open + Submit Handling

**Files:**
- Modify: `packages/adapters/src/chat/slack/adapter.ts`
- Test: `packages/adapters/src/chat/slack/adapter.test.ts`

- [ ] **Step 1: Register new Slack action + modal callbacks**

In `registerGateHandlers()` add:

```ts
this.app.action(
  { type: 'block_actions', action_id: new RegExp(`^${GATE_ACTION_ANSWER_QUESTIONS}\\|`) },
  async ({ ack, body, action, client }) => {
    await ack();
    await this.handleAnswerQuestionsClick({ body, action, client });
  }
);

this.app.view(QUESTIONS_MODAL_CALLBACK, async ({ ack, view, body }) => {
  await ack();
  await this.handleQuestionsModalSubmit({ view, body });
});
```

- [ ] **Step 2: Implement modal builder for all supported question types**

Add helper:

```ts
private buildQuestionsModalBlocks(questions: QuestionDef[]): SlackBlock[]
```

Mapping:
- `yes_no`: input + `radio_buttons`
- `yes_no_text`: one input block for radio + one optional multiline text input
- `select`: input + `static_select`
- `checkboxes`: input + `checkboxes`
- `text`: multiline `plain_text_input`

Store `{ channel, threadTs, userId, questions }` in `private_metadata`.

- [ ] **Step 3: Implement `handleAnswerQuestionsClick`**

Pattern after `handleRequestChangesClick`:
- Extract click context and trigger id.
- Decode action ids.
- Open modal with callback id `gate_questions_modal`.
- On open failure log `slack.questions_modal_open_failed`.

- [ ] **Step 4: Implement `handleQuestionsModalSubmit` + formatter**

Add:

```ts
private formatQuestionsAnswersForLoop(
  questions: QuestionDef[],
  values: Record<
    string,
    Record<
      string,
      {
        value?: string;
        selected_option?: { value?: string };
        selected_options?: Array<{ value?: string }>;
      }
    >
  >
): string
```

Output format:
- Header `Answers:`
- Numbered lines `N. <id>: <value>`
- `checkboxes` comma-separated values
- `yes_no_text` as `yes — "<text>"` when text exists
- optional empties as `(no answer)`

Then dispatch:

```ts
await this.dispatchSyntheticMessage({ channel, threadTs, userId, text: formattedAnswers });
```

- [ ] **Step 5: Run targeted Slack adapter tests**

Run:
```bash
bun test packages/adapters/src/chat/slack/adapter.test.ts
```

Expected: PASS; includes new questions-button, modal-open, and modal-submit assertions.

- [ ] **Step 6: Commit modal interaction implementation**

Run:
```bash
git add packages/adapters/src/chat/slack/adapter.ts packages/adapters/src/chat/slack/adapter.test.ts
git commit -m "feat(slack): collect spec scoping answers via question modal and synthesize loop reply"
```

---

### Task 4: Complete Test Coverage for Fallback + No Regression

**Files:**
- Modify: `packages/adapters/src/chat/slack/adapter.test.ts`

- [ ] **Step 1: Add schema-valid render-path test**

Add test:
- Input message contains prose + valid fenced `archon-questions`.
- `interactiveGate` present.
- Assert `postMessage.blocks` contains markdown + single actions block with `Answer questions`.
- Assert no Approve/Request changes buttons.
- Assert rendered markdown text excludes fenced YAML.

- [ ] **Step 2: Add malformed-schema fallback test**

Add test:
- Input message contains malformed fenced block.
- `interactiveGate` present.
- Assert fallback actions are Approve + Request changes.
- Assert cleaned message does not include raw fenced block.

- [ ] **Step 3: Add no-schema regression test**

Add test:
- Same message without fenced schema.
- Assert current gate behavior remains unchanged.

- [ ] **Step 4: Add modal submit formatting test**

Mock `view_submission` payload for mixed question types and assert synthetic event text is exactly:

```text
Answers:
1. scope_of_change: trial_activated, waiting_trial_webinar
2. test_expectations: yes — "update welcome_header_spec"
3. i18n: no
4. out_of_scope_confirm: yes
```

- [ ] **Step 5: Run package tests**

Run:
```bash
bun test packages/adapters/src/chat/slack/adapter.test.ts
```

Expected: PASS for all Slack adapter tests.

- [ ] **Step 6: Commit tests**

Run:
```bash
git add packages/adapters/src/chat/slack/adapter.test.ts
git commit -m "test(slack): cover question-schema gate rendering, fallback, and modal answer formatting"
```

---

### Task 5: Final Validation + Manual Slack Check

**Files:**
- Verify only modified files from prior tasks

- [ ] **Step 1: Run lint and type-check for touched packages**

Run:
```bash
bun run lint
bun run type-check
```

Expected: PASS with zero warnings/errors.

- [ ] **Step 2: Run full pre-PR validation**

Run:
```bash
bun run validate
```

Expected: PASS (type-check + lint + format check + tests).

- [ ] **Step 3: Manual Slack smoke test**

Manual script:
1. Trigger `archon-slack-feature-to-review-app` with a sample feature request.
2. Confirm first `spec` iteration shows `Answer questions` button.
3. Submit modal and verify the next loop turn uses formatted `Answers:` text.
4. Confirm later approval gate still uses Approve / Request changes.

Expected: end-to-end behavior matches spec acceptance criteria 1-5.

- [ ] **Step 4: Final commit (if any uncommitted validation fixes)**

Run:
```bash
git add .archon/workflows/defaults/archon-slack-feature-to-review-app.yaml packages/adapters/src/chat/slack/adapter.ts packages/adapters/src/chat/slack/adapter.test.ts
git commit -m "feat(slack): add structured scoping-question modal for spec loop"
```

---

## Self-Review

### 1) Spec coverage check
- Prompt schema contract: covered in Task 1.
- Slack button/modal flow: covered in Tasks 2-3.
- Answer formatting back to loop: covered in Task 3 + Task 4 formatting assertion.
- Malformed-schema fallback: covered in Task 4.
- No-regression behavior for existing gate: covered in Task 4.
- Validation/manual acceptance: covered in Task 5.

No uncovered spec requirement found.

### 2) Placeholder scan
- No TODO/TBD markers.
- Each code-changing task includes concrete function names and command steps.
- Test tasks include explicit assertions and expected outputs.

### 3) Type consistency check
- Schema naming consistent: `QuestionDef`, `QuestionType`, `QuestionOption`.
- Action id constant consistent: `GATE_ACTION_ANSWER_QUESTIONS`.
- Modal callback consistent: `QUESTIONS_MODAL_CALLBACK`.
- Formatting function consistently named `formatQuestionsAnswersForLoop`.

No naming or contract mismatches found.
