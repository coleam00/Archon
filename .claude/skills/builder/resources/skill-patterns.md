# Skill Design Patterns

Reference guide for BMAD skill design patterns, best practices, and Anthropic Claude Code skill specification compliance.

## Table of Contents

1. [Anthropic Skill Specification](#anthropic-skill-specification)
2. [Progressive Disclosure Pattern](#progressive-disclosure-pattern)
3. [Token Optimization Strategies](#token-optimization-strategies)
4. [Script Integration Patterns](#script-integration-patterns)
5. [Allowed-Tools Usage](#allowed-tools-usage)
6. [Naming Conventions](#naming-conventions)
7. [Testing Skills](#testing-skills)
8. [Common Anti-Patterns](#common-anti-patterns)

---

## Anthropic Skill Specification

### Required YAML Frontmatter

Every SKILL.md must begin with YAML frontmatter containing required fields:

```yaml
---
name: skill-name
description: Clear description with trigger keywords for when to activate this skill
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite
---
```

### Field Requirements

**name** (required)
- Format: lowercase, hyphenated
- Examples: `qa-engineer`, `security-analyst`, `builder`
- Invalid: `QA Engineer`, `qa_engineer`, `qaEngineer`

**description** (required)
- Clear, concise description of skill purpose
- Include trigger keywords that indicate when to activate
- Examples of trigger keywords: "test planning", "security audit", "deployment", "create agent"
- Length: 50-200 characters recommended

**allowed-tools** (optional but recommended)
- List of Claude Code tools this skill can use
- Available tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite, WebSearch, WebFetch
- Format: Comma-separated list

### YAML Frontmatter Examples

**Good Example:**
```yaml
---
name: security-analyst
description: Security and compliance specialist. Performs security audits, vulnerability assessments, penetration testing. Trigger - security audit, pen test, vulnerability scan, compliance check
allowed-tools: Read, Write, Edit, Bash, Grep, TodoWrite
---
```

**Bad Example (missing trigger keywords):**
```yaml
---
name: SecurityAnalyst
description: Does security stuff
---
```

---

## Progressive Disclosure Pattern

Skills should use a three-level information architecture to stay under token limits while providing comprehensive guidance.

### Level 1: SKILL.md (< 5k tokens)

**Purpose:** Quick reference and overview
**Content:**
- YAML frontmatter
- Role and responsibilities (bullet points)
- Core principles (3-5 items)
- High-level workflow descriptions
- References to Level 2 documentation

**Example Structure:**
```markdown
---
name: skill-name
description: ...
allowed-tools: ...
---

# Skill Name

**Role:** Domain specialist

**Function:** What this skill does

## Responsibilities
- Item 1
- Item 2
- Item 3

## Core Principles
1. **Principle 1** - Brief description
2. **Principle 2** - Brief description

## Workflow Category

### Workflow Name
**Purpose:** What it achieves
**Process:**
1. Step 1
2. Step 2

**See:** [REFERENCE.md](REFERENCE.md) for details
```

### Level 2: REFERENCE.md (< 10k tokens)

**Purpose:** Detailed patterns and examples
**Content:**
- Complete templates with all fields
- Step-by-step processes
- Code examples
- Integration patterns
- Best practices
- References to Level 3 resources

**Example Structure:**
```markdown
# Skill Reference

## Pattern Name

Detailed explanation with examples...

### Template Structure
```
[Full template code]
```

### Example Usage
[Complete example]

**See:** [resources/deep-dive.md](resources/deep-dive.md) for advanced topics
```

### Level 3: resources/ (unlimited)

**Purpose:** Deep reference materials
**Content:**
- Design philosophy documents
- Extended examples and case studies
- Troubleshooting guides
- Performance optimization
- Architecture decisions

**Example Files:**
- `resources/skill-patterns.md` - Design patterns
- `resources/best-practices.md` - Best practices
- `resources/examples/` - Complete examples
- `resources/troubleshooting.md` - Common issues

---

## Token Optimization Strategies

### 1. Reference, Don't Duplicate

**Bad (duplicates content):**
```markdown
## Workflow 1
[Full 500-line workflow description]

## Workflow 2
[Full 500-line workflow description]

## Workflow 3
[Full 500-line workflow description]
```

**Good (references):**
```markdown
## Workflow 1
**Purpose:** Brief description
**See:** [REFERENCE.md#workflow-1](REFERENCE.md#workflow-1)

## Workflow 2
**Purpose:** Brief description
**See:** [REFERENCE.md#workflow-2](REFERENCE.md#workflow-2)
```

### 2. Use Templates with Variables

**Bad (multiple hardcoded examples):**
```markdown
Example 1:
[Full example with QA Engineer]

Example 2:
[Full example with DevOps Engineer]

Example 3:
[Full example with Security Engineer]
```

**Good (single template):**
```markdown
**See:** [templates/skill.template.md](templates/skill.template.md)

Replace variables:
- {{skill_name}} - Your skill name
- {{description}} - Your description
```

### 3. Link to External Resources

**Bad (embeds large blocks):**
```markdown
## Design Patterns

[2000 lines of design pattern documentation]

## Best Practices

[1500 lines of best practices]
```

**Good (links):**
```markdown
## Design Patterns
See [resources/skill-patterns.md](resources/skill-patterns.md)

## Best Practices
See [resources/best-practices.md](resources/best-practices.md)
```

### 4. Minimize Repetition

**Bad (repeats structure):**
```markdown
## Responsibility 1
This skill is responsible for...

## Responsibility 2
This skill is responsible for...

## Responsibility 3
This skill is responsible for...
```

**Good (concise list):**
```markdown
## Responsibilities
- Responsibility 1
- Responsibility 2
- Responsibility 3
```

### 5. One Good Example vs Many

**Bad (multiple similar examples):**
```markdown
Example 1: [Full example]
Example 2: [Full example]
Example 3: [Full example]
Example 4: [Full example]
```

**Good (one with variations):**
```markdown
Example: [One complete example]
For variations, see [REFERENCE.md#examples](REFERENCE.md#examples)
```

---

## Script Integration Patterns

### Validation Scripts

**Purpose:** Validate skill files before deployment

**Pattern:**
```bash
#!/bin/bash
# validate-skill.sh

# 1. Check file exists
# 2. Validate YAML frontmatter
# 3. Check required fields
# 4. Validate format
# 5. Report results
```

**Usage in SKILL.md:**
```markdown
## Validation

Validate this skill:
```bash
./scripts/validate-skill.sh SKILL.md
```
```

### Scaffolding Scripts

**Purpose:** Create directory structure for new skills

**Pattern:**
```bash
#!/bin/bash
# scaffold-skill.sh

# 1. Validate skill name
# 2. Create directory structure
# 3. Create placeholder files
# 4. Generate README files
# 5. Report success
```

**Usage in SKILL.md:**
```markdown
## Creating New Skills

Scaffold a new skill:
```bash
./scripts/scaffold-skill.sh new-skill-name
```
```

### Testing Scripts

**Purpose:** Test skill functionality

**Pattern:**
```bash
#!/bin/bash
# test-skill.sh

# 1. Load skill
# 2. Run test cases
# 3. Validate outputs
# 4. Report results
```

### Script Best Practices

1. **Error Handling:** Use `set -euo pipefail`
2. **Usage Information:** Provide clear usage() function
3. **Colored Output:** Use colors for readability
4. **Validation:** Check inputs before processing
5. **Exit Codes:** Return appropriate exit codes
6. **Documentation:** Include comments explaining logic

---

## Allowed-Tools Usage

### Tool Categories

**File Operations:**
- `Read` - Read file contents
- `Write` - Write new files
- `Edit` - Edit existing files

**Search Operations:**
- `Glob` - Find files by pattern
- `Grep` - Search file contents

**Execution:**
- `Bash` - Execute shell commands

**Workflow:**
- `TodoWrite` - Track tasks

**Web:**
- `WebSearch` - Search web
- `WebFetch` - Fetch web content

### Choosing Tools for Your Skill

**For file-heavy skills:**
```yaml
allowed-tools: Read, Write, Edit, Glob, Grep, TodoWrite
```

**For execution-focused skills:**
```yaml
allowed-tools: Read, Bash, Grep, TodoWrite
```

**For research skills:**
```yaml
allowed-tools: Read, WebSearch, WebFetch, TodoWrite
```

**For creation skills:**
```yaml
allowed-tools: Read, Write, Edit, TodoWrite
```

### Tool Usage Patterns

**Read before Write/Edit:**
```markdown
## Workflow Step
1. Read existing file with Read tool
2. Modify content
3. Write/Edit file
```

**Search before Read:**
```markdown
## Workflow Step
1. Find files with Glob
2. Search content with Grep
3. Read relevant files with Read
```

**Track with TodoWrite:**
```markdown
## Workflow Execution
Use TodoWrite to track:
1. Step 1
2. Step 2
3. Step 3
```

---

## Naming Conventions

### Skill Names

**Format:** lowercase, hyphenated
**Pattern:** `{domain}-{role}` or `{function}-{specialization}`

**Examples:**
- `qa-engineer` - QA domain, engineer role
- `security-analyst` - Security domain, analyst role
- `devops-engineer` - DevOps domain, engineer role
- `data-scientist` - Data domain, scientist role
- `builder` - Function-focused

**Anti-patterns:**
- `QAEngineer` - CamelCase (wrong)
- `qa_engineer` - Snake_case (wrong)
- `qa engineer` - Spaces (wrong)

### File Names

**SKILL.md:**
- Always uppercase `SKILL.md`
- Never `skill.md` or `Skill.md`

**REFERENCE.md:**
- Always uppercase `REFERENCE.md`
- Never `reference.md` or `Reference.md`

**Scripts:**
- Lowercase, hyphenated
- Extension: `.sh` for bash scripts
- Examples: `validate-skill.sh`, `scaffold-skill.sh`, `test-skill.sh`

**Templates:**
- Lowercase, hyphenated
- Extension: `.md` for markdown templates
- Suffix: `.template.md`
- Examples: `skill.template.md`, `workflow.template.md`, `document.template.md`

**Resources:**
- Lowercase, hyphenated
- Extension: `.md` for markdown
- Examples: `skill-patterns.md`, `best-practices.md`, `troubleshooting.md`

### Directory Names

**Standard subdirectories:**
- `scripts/` - Never `script/` or `Scripts/`
- `templates/` - Never `template/` or `Templates/`
- `resources/` - Never `resource/` or `Resources/`

---

## Testing Skills

### Pre-Deployment Checklist

**YAML Validation:**
- [ ] YAML frontmatter present
- [ ] `name` field exists and follows format
- [ ] `description` field exists with trigger keywords
- [ ] `allowed-tools` specified (if needed)

**Content Validation:**
- [ ] Under 5k tokens (use wc or token counter)
- [ ] References work (REFERENCE.md, resources/)
- [ ] Examples are clear and complete
- [ ] No spelling/grammar errors
- [ ] Code blocks properly formatted

**Structure Validation:**
- [ ] Follows progressive disclosure pattern
- [ ] Has clear sections
- [ ] Uses bullet points appropriately
- [ ] Links are relative and correct

**Functional Testing:**
- [ ] Skill loads without errors
- [ ] Workflows execute correctly
- [ ] Tools work as expected
- [ ] Scripts run successfully

### Testing Process

1. **Static Validation:**
```bash
./scripts/validate-skill.sh SKILL.md
```

2. **Manual Review:**
- Read through SKILL.md
- Check all links
- Verify examples

3. **Load Testing:**
- Load skill in Claude Code
- Test activation triggers
- Verify tool usage

4. **Workflow Testing:**
- Execute each workflow
- Verify outputs
- Check error handling

5. **Integration Testing:**
- Test with other skills
- Verify references work
- Check tool interactions

### Test Cases Template

```markdown
# Test Cases for {{skill_name}}

## Test Case 1: Skill Loading
- Load skill in Claude Code
- Expected: Skill loads without errors
- Status: [ ]

## Test Case 2: Trigger Activation
- Use trigger keywords from description
- Expected: Skill activates appropriately
- Status: [ ]

## Test Case 3: Workflow Execution
- Execute primary workflow
- Expected: Workflow completes successfully
- Status: [ ]

## Test Case 4: Tool Usage
- Use each allowed tool
- Expected: Tools work as expected
- Status: [ ]

## Test Case 5: References
- Follow all links in SKILL.md
- Expected: All references resolve correctly
- Status: [ ]
```

---

## Common Anti-Patterns

### Anti-Pattern 1: Persona-Based Skills

**Bad:**
```yaml
---
name: friendly-qa-engineer
description: A friendly QA engineer who loves testing and uses emojis!
---

# Friendly QA Engineer

Hi! I'm your friendly QA engineer! I love testing! 😄
```

**Why it's bad:**
- Persona-based, not functional
- Wastes tokens on personality
- Inconsistent with BMAD principles

**Good:**
```yaml
---
name: qa-engineer
description: QA and testing specialist. Creates test plans, executes tests, validates quality.
---

# QA Engineer

**Role:** Quality assurance specialist
**Function:** Test planning, execution, and quality validation
```

### Anti-Pattern 2: Missing YAML Frontmatter

**Bad:**
```markdown
# My Skill

This is a skill for doing things.
```

**Why it's bad:**
- No YAML frontmatter
- Won't work with Claude Code skill system
- Missing required fields

**Good:**
```markdown
---
name: my-skill
description: Does specific things when triggered
allowed-tools: Read, Write
---

# My Skill
```

### Anti-Pattern 3: Token Bloat

**Bad:**
```markdown
## Workflow 1

[2000 lines of detailed workflow]

## Workflow 2

[2000 lines of detailed workflow]

## Workflow 3

[2000 lines of detailed workflow]
```

**Why it's bad:**
- Exceeds token limits
- Duplicates information
- Hard to maintain

**Good:**
```markdown
## Workflows

### Workflow 1
**Purpose:** Brief description
**See:** [REFERENCE.md#workflow-1](REFERENCE.md#workflow-1)

### Workflow 2
**Purpose:** Brief description
**See:** [REFERENCE.md#workflow-2](REFERENCE.md#workflow-2)
```

### Anti-Pattern 4: No Tool Specification

**Bad:**
```yaml
---
name: file-manager
description: Manages files
---
```

**Why it's bad:**
- No allowed-tools specified
- Unclear what tools skill uses
- May cause permission issues

**Good:**
```yaml
---
name: file-manager
description: Manages files with read, write, and edit operations
allowed-tools: Read, Write, Edit, Glob, Grep
---
```

### Anti-Pattern 5: Broken References

**Bad:**
```markdown
**See:** [REFERENCE.md](REFERENCE.md)
[But REFERENCE.md doesn't exist]

**See:** [resources/patterns.md](resources/patterns.md)
[But resources/ directory doesn't exist]
```

**Why it's bad:**
- Broken links
- Frustrating user experience
- Indicates incomplete work

**Good:**
```markdown
**See:** [REFERENCE.md](REFERENCE.md)
[REFERENCE.md exists and is complete]

**See:** [resources/patterns.md](resources/patterns.md)
[File exists with content]
```

### Anti-Pattern 6: Vague Descriptions

**Bad:**
```yaml
description: Does stuff with things
```

**Why it's bad:**
- No trigger keywords
- Unclear purpose
- Won't activate appropriately

**Good:**
```yaml
description: QA specialist. Creates test plans, executes tests, validates quality. Trigger - test planning, QA, testing, quality assurance
```

### Anti-Pattern 7: Wrong Naming Format

**Bad:**
```yaml
name: QAEngineer
name: qa_engineer
name: qa engineer
```

**Why it's bad:**
- Doesn't follow lowercase-hyphenated format
- May cause issues with file systems
- Inconsistent with conventions

**Good:**
```yaml
name: qa-engineer
```

### Anti-Pattern 8: No TodoWrite Integration

**Bad:**
```markdown
## Workflow
1. Do step 1
2. Do step 2
3. Do step 3

[No mention of TodoWrite for tracking]
```

**Why it's bad:**
- No progress tracking
- Unclear completion status
- Poor user experience

**Good:**
```markdown
## Workflow

Use TodoWrite to track:
1. Step 1
2. Step 2
3. Step 3

[Throughout execution, update TodoWrite status]
```

---

## Summary

**Key Takeaways:**

1. **Always use YAML frontmatter** with `name` and `description`
2. **Follow progressive disclosure** - SKILL.md < 5k tokens
3. **Use references** instead of duplication
4. **Specify allowed-tools** based on skill needs
5. **Follow naming conventions** - lowercase, hyphenated
6. **Integrate TodoWrite** for workflow tracking
7. **Test before deployment** - validate, test, verify
8. **Avoid anti-patterns** - no personas, no bloat, no broken links

**Resources:**

- [Anthropic Skill Specification](#anthropic-skill-specification)
- [Progressive Disclosure Pattern](#progressive-disclosure-pattern)
- [Token Optimization Strategies](#token-optimization-strategies)
- [Testing Skills](#testing-skills)

**Tools:**

- `scripts/validate-skill.sh` - Validate SKILL.md
- `scripts/scaffold-skill.sh` - Create skill structure
- `templates/skill.template.md` - Skill template
- `templates/workflow.template.md` - Workflow template

---

*This document is part of the BMAD Builder skill package.*
