# Definition of Done

> Agents MUST satisfy every applicable item on this checklist before calling `archon_complete_task`.
> Skip items that are explicitly not applicable (e.g., "no code changes in this task").

---

## Checklist

### Code & Implementation

- [ ] All code changes committed to the appropriate branch
- [ ] Changes pushed to remote (if applicable)
- [ ] No linting errors (`ruff check` / `npm run biome` / `npm run lint` as applicable)
- [ ] No type errors (`mypy src/` / `npx tsc --noEmit` as applicable)
- [ ] All existing tests pass — no regressions introduced

### Documentation

- [ ] Relevant doc updated or explicitly confirmed as still current
- [ ] If a new pattern was introduced, it is documented in `PRPs/ai_docs/`
- [ ] If a new API endpoint was added, it is referenced in `PRPs/ai_docs/API_NAMING_CONVENTIONS.md`

### Task Hygiene

- [ ] All sub-task checkboxes in the task `description` are checked (`- [x]`)
- [ ] No open sub-tasks remain
- [ ] If work is incomplete, a follow-on task has been created in Archon with context

### Handover (if another agent continues)

- [ ] Handover note left at top of task `description` (`[HANDOFF → <agent>]`)
- [ ] `assignee` updated to next agent
- [ ] Sufficient context provided for the next agent to pick up without asking questions

### Security (if applicable)

- [ ] No secrets, tokens, or credentials committed to version control
- [ ] If a security-sensitive issue was encountered or resolved, an entry created in:
  `~/Documents/Documentation/System/ISSUES_KNOWLEDGE_BASE.md`

### Final Step

- [ ] `archon_complete_task(task_id="<uuid>")` called — status becomes `done`

---

## Quick Reference: When to Skip Items

| Item | Skip when |
|------|-----------|
| Code committed / pushed | Task is documentation-only or research-only |
| Linting / type checks | No code files were modified |
| Tests pass | No code changes; no test suite in scope |
| Doc updated | Task explicitly excluded documentation |
| Security KB entry | No security-sensitive work involved |

---

## References

- Agile ↔ Archon mapping: `PRPs/ai_docs/AGILE_WORKFLOW.md`
- Sprint workflow: `docs/SPRINT_WORKFLOW.md`
- Agent roles: `AGENTS.md`
