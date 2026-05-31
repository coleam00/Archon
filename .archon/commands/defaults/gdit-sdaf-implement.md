---
description: Execute spec-driven implementation with GDIT protocol header and Archon validation loops
argument-hint: <.kiro/specs/feature-name/> or <path/to/plan.md>
---

# GDIT Implement

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Execute tasks from a GDIT spec OR an Archon plan. GDIT specs get the full protocol header; Archon plans use Archon's standard implementation flow. Either way: validate after every file change.

---

## Phase 0: DETECT INPUT TYPE

Check $ARGUMENTS:

- Directory ending in `/` or containing `tasks.md` → GDIT spec mode
- `.md` file → Archon plan mode
- Empty → check `$ARTIFACTS_DIR/plan.md`; if found, Archon plan mode

---

## Phase 1 (GDIT MODE): MANDATORY FIRST ACTION

**FAILURE TO EXECUTE THIS SEQUENCE = PROTOCOL VIOLATION**

1. Find tasks.md files:

```bash
find . -name "tasks.md" -path "*/.kiro/specs/*" 2>/dev/null
```

2. Read EVERY tasks.md found — no partial reading.

3. Read requirements.md and design.md for the target spec.

4. Identify the EXACT task being implemented. Quote it verbatim.

5. List ALL requirement numbers this task addresses.

6. Quote the relevant design section guidance.

7. Present the SPEC-DRIVEN IMPLEMENTATION PROTOCOL header:

```
SPEC-DRIVEN IMPLEMENTATION PROTOCOL

Specification Discovery:
- Spec location: .kiro/specs/<feature>/
- Task: Task N: <exact task text>
- Requirements: REQ-N, REQ-M
- Design quote: "<quoted design text>"

Compliance Verification:
- [x] Specification read completely
- [x] Task identified with exact number and text
- [x] Requirements listed
- [x] Design guidance quoted
- [x] No assumptions beyond specs
```

8. **Wait for user confirmation** before writing any code.

---

## Phase 1 (ARCHON PLAN MODE): LOAD PLAN

Follow `archon-implement.md` Phase 0–1 (detect package manager, read plan, extract tasks).

---

## Phase 2: DETECT PROJECT TOOLCHAIN

```bash
test -f bun.lockb && echo "bun" || \
test -f pnpm-lock.yaml && echo "pnpm" || \
test -f yarn.lock && echo "yarn" || \
test -f package-lock.json && echo "npm" || \
test -f pyproject.toml && echo "uv" || \
echo "unknown"
```

---

## Phase 3: IMPLEMENT EACH TASK

For each task/step:

### 3.1 Read Context

- Read the file to modify (understand current state)
- Identify the exact pattern to follow (from design.md or plan "mirror" reference)

### 3.2 Make the Change

- Implement the task as specified — no scope creep beyond the task
- **CREATE**: write new file following pattern
- **UPDATE**: modify existing file as described

### 3.3 Validate After EVERY File Change

```bash
{runner} run type-check 2>&1 | tail -20
```

If fails: fix before moving to the next task.

### 3.4 Task Checkpoint (GDIT mode)

After each completed task (not the final), note progress and check for blockers.

---

## Phase 4: POST-IMPLEMENTATION VALIDATION

```bash
{runner} run type-check
{runner} run lint
{runner} run test
```

Fix any failures. Do not proceed until all pass.

---

## Phase 5: GDIT POST-TASK AUDIT (GDIT MODE ONLY)

```bash
python3 ~/.kiro/scripts/audit-steering-compliance.py .kiro/specs/<feature>/
```

Report all PASS/FAIL/WARN/SKIP results. If any FAIL: remediate before declaring complete.

---

## Phase 6: REPORT

State which tasks were completed, which tests pass, and the audit result.
Present the list of modified files for the next `gdit-sdaf-checkpoint` step.
