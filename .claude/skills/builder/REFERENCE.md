# Builder Reference

Detailed patterns and examples for creating custom agents, workflows, and templates.

## Skill Creation Patterns

### YAML Frontmatter Structure

Every SKILL.md must begin with YAML frontmatter:

```yaml
---
name: skill-name
description: Clear description with trigger keywords. When to activate this skill - specific scenarios, commands, or contexts that should load this skill.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite
---
```

**Field Descriptions:**

- **name** (required): Lowercase, hyphenated identifier (e.g., `qa-engineer`, `security-analyst`)
- **description** (required): Clear description including trigger keywords that help Claude know when to activate this skill
- **allowed-tools** (optional but recommended): List of Claude Code tools this skill can use

### Skill Template Structure

```markdown
---
name: {{skill_name}}
description: {{description}}
allowed-tools: {{tools}}
---

# {{Skill Display Name}}

**Role:** {{Phase/Domain}} specialist

**Function:** {{What this agent does}}

## Responsibilities

- {{Responsibility 1}}
- {{Responsibility 2}}
- {{Responsibility 3}}

## Core Principles

1. **{{Principle 1}}** - {{Description}}
2. **{{Principle 2}}** - {{Description}}
3. **{{Principle 3}}** - {{Description}}

## {{Workflow Category Name}}

### {{Workflow Name}}

**Purpose:** {{What this workflow achieves}}

**Process:**
1. {{Step 1}}
2. {{Step 2}}
3. {{Step 3}}

**See:** [REFERENCE.md](REFERENCE.md) for detailed patterns

## Available Scripts

{{List any validation or utility scripts}}

## File Organization

{{Describe directory structure}}

## Installation Process

{{How to install/use this skill}}

## Notes for LLMs

- {{LLM-specific guidance}}
- Use TodoWrite to track tasks
- {{Domain-specific considerations}}
```

### Progressive Disclosure Pattern

**Level 1 (SKILL.md):** Overview and essential information (keep under 5k tokens)
- YAML frontmatter
- Role and responsibilities
- Core principles
- High-level workflow descriptions
- References to Level 2

**Level 2 (REFERENCE.md):** Detailed patterns and examples
- Complete templates
- Step-by-step processes
- Code examples
- Integration patterns
- References to Level 3

**Level 3 (resources/):** Deep reference materials
- Design patterns
- Best practices
- Extended examples
- Troubleshooting guides

## Workflow Creation Patterns

### Workflow Template Structure

```markdown
You are the {{Agent Name}}, executing the **{{Workflow Name}}** workflow.

## Workflow Overview

**Goal:** {{What this workflow achieves}}
**Agent:** {{Agent name}}
**Inputs:** {{Required inputs}}
**Output:** {{What is produced}}
**Duration:** {{Estimated time}}

## Pre-Flight Checks

Before starting, verify:
1. {{Prerequisite 1}}
2. {{Prerequisite 2}}
3. {{Prerequisite 3}}

## {{Workflow Name}} Process

Use TodoWrite to track these steps:
1. {{Step 1 description}}
2. {{Step 2 description}}
3. {{Step 3 description}}
4. {{Step 4 description}}

## Part 1: {{Step Name}}

{{Detailed instructions for this step}}

**Actions:**
- {{Action 1}}
- {{Action 2}}

**Output:** {{What is produced in this step}}

## Part 2: {{Step Name}}

{{Detailed instructions for this step}}

**Actions:**
- {{Action 1}}
- {{Action 2}}

**Output:** {{What is produced in this step}}

## Part 3: {{Step Name}}

{{Detailed instructions for this step}}

**Actions:**
- {{Action 1}}
- {{Action 2}}

**Output:** {{What is produced in this step}}

## Generate Output

{{Instructions for generating final output}}

**Output Format:**
```
{{Example output structure}}
```

## Status Update

Mark workflow as complete:
- Update TodoWrite status
- {{Other status tracking}}

## Recommend Next Steps

Suggest logical next actions:
- {{Next step 1}}
- {{Next step 2}}
- {{Next step 3}}
```

### Workflow Best Practices

1. **TodoWrite Integration:** Always use TodoWrite to track workflow steps
2. **Clear Inputs/Outputs:** Define what goes in and what comes out
3. **Pre-flight Checks:** Validate prerequisites before starting
4. **Incremental Progress:** Break into manageable steps
5. **Status Updates:** Track progress and completion
6. **Next Steps:** Guide users on what to do after workflow completes

## Template Creation Patterns

### Document Template Structure

```markdown
# {{Document Type}}: {{project_name}}

**Date:** {{date}}
**Author:** {{author_name}}
**Version:** {{version}}
**Status:** {{status}}

## Executive Summary

{{executive_summary}}

## Section 1: {{Section Name}}

{{section_1_content}}

### Subsection 1.1: {{Subsection Name}}

{{subsection_1_1_content}}

### Subsection 1.2: {{Subsection Name}}

{{subsection_1_2_content}}

## Section 2: {{Section Name}}

{{section_2_content}}

### Subsection 2.1: {{Subsection Name}}

{{subsection_2_1_content}}

## Section 3: {{Section Name}}

{{section_3_content}}

## Appendix

{{appendix_content}}

---

**Document Control:**
- **Template Version:** {{template_version}}
- **Last Updated:** {{last_updated}}
- **Next Review:** {{next_review}}
```

### Template Variable Naming

Use `{{variable_name}}` syntax for placeholders:
- **Lowercase with underscores:** `{{project_name}}`, `{{author_name}}`
- **Descriptive names:** `{{test_plan_scope}}` not `{{scope}}`
- **Consistent naming:** Use same variable names across related templates

### Common Template Variables

**Project Context:**
- `{{project_name}}` - Project name
- `{{project_version}}` - Version number
- `{{project_description}}` - Brief description

**Authorship:**
- `{{author_name}}` - Author/creator name
- `{{date}}` - Creation date
- `{{last_updated}}` - Last modification date

**Status:**
- `{{status}}` - Current status (Draft, Review, Approved, etc.)
- `{{version}}` - Document version

**Content:**
- `{{section_name_content}}` - Section-specific content
- `{{executive_summary}}` - High-level summary
- `{{appendix_content}}` - Supplementary material

## Skill Validation

### Required YAML Fields

Validate every SKILL.md has:
1. `name` field (lowercase, hyphenated)
2. `description` field (with trigger keywords)

### Recommended YAML Fields

Include these for better Claude integration:
1. `allowed-tools` - List of tools skill can use
2. Custom metadata as needed

### Validation Script Usage

```bash
# Validate single skill
./scripts/validate-skill.sh /path/to/SKILL.md

# Validate all skills in directory
find . -name "SKILL.md" -exec ./scripts/validate-skill.sh {} \;
```

## Directory Scaffolding

### Standard Skill Directory Structure

```
skill-name/
├── SKILL.md                 # Main entry point (required)
├── REFERENCE.md             # Detailed patterns (optional)
├── scripts/                 # Utility scripts (optional)
│   ├── validate-skill.sh
│   └── scaffold-skill.sh
├── templates/               # Reusable templates (optional)
│   ├── skill.template.md
│   ├── workflow.template.md
│   └── document.template.md
└── resources/               # Reference materials (optional)
    └── skill-patterns.md
```

### Scaffolding Script Usage

```bash
# Create new skill directory structure
./scripts/scaffold-skill.sh new-skill-name

# Creates:
# new-skill-name/
# ├── scripts/
# ├── templates/
# └── resources/
```

## Domain-Specific Examples

### QA Engineering Skill

```yaml
---
name: qa-engineer
description: QA and testing specialist. Creates test plans, executes tests, validates quality. Trigger - test planning, quality assurance, test execution, test automation, QA workflow
allowed-tools: Read, Write, Edit, Bash, Grep, TodoWrite
---
```

**Workflows:**
- /create-test-plan
- /execute-tests
- /analyze-coverage

**Templates:**
- test-plan.md
- test-report.md
- bug-report.md

### DevOps Engineering Skill

```yaml
---
name: devops-engineer
description: DevOps and infrastructure specialist. Handles deployment, monitoring, infrastructure. Trigger - deploy, rollback, infrastructure, CI/CD, DevOps workflow
allowed-tools: Read, Write, Edit, Bash, Grep, TodoWrite
---
```

**Workflows:**
- /deploy
- /rollback
- /infrastructure-audit
- /setup-ci-cd

**Templates:**
- deployment-runbook.md
- incident-report.md
- infrastructure-plan.md

### Security Engineering Skill

```yaml
---
name: security-engineer
description: Security and compliance specialist. Performs security audits, penetration testing, vulnerability assessment. Trigger - security audit, penetration test, vulnerability scan, security assessment
allowed-tools: Read, Write, Edit, Bash, Grep, TodoWrite
---
```

**Workflows:**
- /security-audit
- /penetration-test
- /vulnerability-scan

**Templates:**
- security-assessment.md
- penetration-test-report.md
- compliance-checklist.md

## Token Optimization Strategies

### 1. Reference External Files

Instead of embedding large blocks in SKILL.md:
```markdown
**See:** [REFERENCE.md](REFERENCE.md) for detailed workflow patterns
```

### 2. Use Progressive Disclosure

- SKILL.md: Overview (< 5k tokens)
- REFERENCE.md: Details (< 10k tokens)
- resources/: Deep dives (unlimited)

### 3. Link, Don't Duplicate

Instead of repeating patterns:
```markdown
Follow the standard workflow pattern described in [REFERENCE.md#workflow-pattern](REFERENCE.md#workflow-pattern)
```

### 4. Template Variables

Use templates with variables instead of multiple examples:
```markdown
See [templates/skill.template.md](templates/skill.template.md) for skill structure
```

### 5. Minimal Examples

Provide one good example, reference more:
```markdown
Example: See qa-engineer skill for reference implementation
```

## Integration Patterns

### Tool Integration

Specify allowed-tools based on skill needs:

**File Operations:**
- Read, Write, Edit - File manipulation
- Glob, Grep - File search and pattern matching

**Execution:**
- Bash - Command execution, scripts

**Workflow:**
- TodoWrite - Task tracking

### Skill Composition

Custom skills can reference other skills:
```markdown
## Integration Points

**Works with:**
- builder - Create custom workflows
- validator - Validate outputs
- Domain-specific skills as needed
```

### Workflow Chaining

Link workflows together:
```markdown
## Recommend Next Steps

After completing this workflow:
- /next-workflow - Continue with next phase
- /validate-output - Verify results
- /generate-report - Document findings
```

## Testing and Validation

### Skill Testing Checklist

- [ ] YAML frontmatter present and valid
- [ ] Name field lowercase and hyphenated
- [ ] Description includes trigger keywords
- [ ] Allowed-tools specified
- [ ] Under 5k tokens
- [ ] References work correctly
- [ ] Examples are clear and complete

### Workflow Testing Checklist

- [ ] TodoWrite integration present
- [ ] Pre-flight checks defined
- [ ] Steps are clear and actionable
- [ ] Inputs/outputs specified
- [ ] Status update mechanism included
- [ ] Next steps recommended

### Template Testing Checklist

- [ ] Variables use {{variable_name}} syntax
- [ ] All placeholders documented
- [ ] Template structure is clear
- [ ] Example usage provided
- [ ] Substitution logic tested

## Common Patterns

### Pattern: Multi-Step Workflow

```markdown
## {{Workflow Name}} Process

Use TodoWrite to track:
1. {{Step 1}}
2. {{Step 2}}
3. {{Step 3}}
4. {{Step 4}}

## Part 1: {{Step 1}}
{{Details}}

## Part 2: {{Step 2}}
{{Details}}

[etc.]
```

### Pattern: Conditional Steps

```markdown
## {{Step Name}}

If {{condition}}:
- {{Action A}}

Otherwise:
- {{Action B}}
```

### Pattern: Parallel Tasks

```markdown
## {{Step Name}}

Execute in parallel:
- Task A: {{description}}
- Task B: {{description}}
- Task C: {{description}}

Wait for all to complete before proceeding.
```

### Pattern: Validation Points

```markdown
## {{Step Name}}

After completion, validate:
- [ ] {{Check 1}}
- [ ] {{Check 2}}
- [ ] {{Check 3}}

If validation fails, {{remediation action}}.
```

## Best Practices Summary

1. **Always include YAML frontmatter** with required fields
2. **Keep SKILL.md under 5k tokens** using references
3. **Use TodoWrite** in all workflows for task tracking
4. **Specify allowed-tools** based on skill needs
5. **Include trigger keywords** in description
6. **Validate before deployment** using validate-skill.sh
7. **Follow naming conventions** (lowercase, hyphenated)
8. **Document integration points** with other skills
9. **Provide clear examples** without redundancy
10. **Test thoroughly** before considering complete
