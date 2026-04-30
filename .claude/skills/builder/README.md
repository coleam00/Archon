# Builder Skill Package

Custom agent and workflow creation specialist for BMAD. Extends BMAD functionality with domain-specific components.

## Overview

The Builder skill helps create custom agents, workflows, and templates following Anthropic Claude Code skill specification. It provides templates, validation scripts, and comprehensive design patterns for building professional skills.

## Quick Start

```bash
# Validate the Builder skill itself
./scripts/validate-skill.sh SKILL.md

# Create a new skill directory structure
./scripts/scaffold-skill.sh my-custom-skill

# Copy and customize a template
cp templates/skill.template.md my-custom-skill/SKILL.md
# Edit and replace {{variables}} with your values

# Validate your new skill
./scripts/validate-skill.sh my-custom-skill/SKILL.md
```

## Directory Structure

```
builder/
├── SKILL.md                      # Main skill definition (< 5k tokens)
├── REFERENCE.md                  # Detailed patterns and examples
├── README.md                     # This file
├── scripts/                      # Utility scripts
│   ├── validate-skill.sh        # Validate SKILL.md YAML frontmatter
│   └── scaffold-skill.sh        # Create skill directory structure
├── templates/                    # Reusable templates
│   ├── skill.template.md        # Template for SKILL.md files
│   ├── workflow.template.md     # Template for workflow commands
│   └── document.template.md     # Template for document templates
└── resources/                    # Reference materials
    └── skill-patterns.md        # Comprehensive design patterns guide
```

## Files

### Core Files

**SKILL.md**
- Main entry point for the Builder skill
- Contains YAML frontmatter with metadata
- Overview of capabilities and workflows
- Token-optimized (< 5k tokens)
- References REFERENCE.md for details

**REFERENCE.md**
- Detailed patterns and examples
- Complete template structures
- Step-by-step processes
- Best practices
- Domain-specific examples

### Scripts

**validate-skill.sh**
- Validates SKILL.md has required YAML frontmatter
- Checks `name`, `description`, and `allowed-tools` fields
- Validates naming conventions
- Provides clear error messages

**scaffold-skill.sh**
- Creates standard skill directory structure
- Generates scripts/, templates/, resources/ subdirectories
- Creates placeholder README files
- Validates skill name format

### Templates

**skill.template.md**
- Complete SKILL.md template with {{variables}}
- Includes YAML frontmatter structure
- Follows Anthropic specification
- Ready to customize

**workflow.template.md**
- Template for creating workflow commands
- Includes TodoWrite integration
- Pre-flight checks, steps, validation
- Status updates and next steps

**document.template.md**
- Template for document templates
- {{variable}} placeholders for substitution
- Standard sections and metadata
- Document control information

### Resources

**skill-patterns.md**
- Comprehensive design patterns reference
- Anthropic skill specification details
- Progressive disclosure pattern (Level 1/2/3)
- Token optimization strategies
- Script integration patterns
- Allowed-tools usage guide
- Naming conventions
- Testing guidelines
- Common anti-patterns to avoid

## Usage Examples

### Creating a QA Engineer Skill

```bash
# 1. Create directory structure
./scripts/scaffold-skill.sh qa-engineer

# 2. Copy template
cp templates/skill.template.md qa-engineer/SKILL.md

# 3. Edit qa-engineer/SKILL.md and replace variables:
# {{skill_name}} → qa-engineer
# {{description}} → QA specialist. Test planning, execution, validation. Trigger - test, QA, quality
# {{allowed_tools}} → Read, Write, Edit, Bash, Grep, TodoWrite
# ... (replace all other variables)

# 4. Validate
./scripts/validate-skill.sh qa-engineer/SKILL.md

# 5. Deploy to ~/.claude/skills/
cp -r qa-engineer ~/.claude/skills/bmad-skills/
```

### Creating a Custom Workflow

```bash
# 1. Copy workflow template
cp templates/workflow.template.md deploy-workflow.md

# 2. Edit deploy-workflow.md and replace variables:
# {{Agent_Name}} → DevOps Engineer
# {{Workflow_Name}} → Deploy to Production
# {{workflow_goal}} → Deploy application to production environment
# ... (replace all other variables)

# 3. Test workflow
# Load in Claude Code and execute
```

### Creating a Document Template

```bash
# 1. Copy document template
cp templates/document.template.md security-assessment.template.md

# 2. Edit and customize sections
# Replace {{variables}} with appropriate placeholders
# Add domain-specific sections

# 3. Use template
# Apply template and substitute variables
```

## Validation

The `validate-skill.sh` script checks:

- YAML frontmatter exists
- Required `name` field (lowercase, hyphenated)
- Required `description` field (with trigger keywords)
- Optional `allowed-tools` field
- File size (warns if > 20KB / ~5k tokens)

**Example:**
```bash
$ ./scripts/validate-skill.sh SKILL.md
Validating: SKILL.md

✓ YAML frontmatter found
✓ 'name' field present: builder
✓ 'description' field present
✓ 'allowed-tools' field present: Read, Write, Edit, Bash, Glob, Grep, TodoWrite

═══════════════════════════════════════
✓ VALIDATION PASSED
  No errors or warnings
```

## Best Practices

1. **Always use YAML frontmatter** in SKILL.md
2. **Keep SKILL.md under 5k tokens** using progressive disclosure
3. **Use references** to REFERENCE.md instead of duplicating
4. **Validate before deployment** with validate-skill.sh
5. **Follow naming conventions** (lowercase, hyphenated)
6. **Include trigger keywords** in description
7. **Specify allowed-tools** based on skill needs
8. **Test thoroughly** before considering complete

## Progressive Disclosure Pattern

**Level 1: SKILL.md** (< 5k tokens)
- YAML frontmatter
- Overview and essentials
- References to Level 2

**Level 2: REFERENCE.md** (< 10k tokens)
- Detailed patterns
- Complete examples
- References to Level 3

**Level 3: resources/** (unlimited)
- Deep reference materials
- Extended examples
- Design philosophy

## Token Optimization

Keep SKILL.md under 5k tokens by:

1. **Referencing instead of duplicating**
   - Link to REFERENCE.md for details
   - Use templates instead of examples

2. **Using bullet points**
   - Concise responsibility lists
   - Brief workflow descriptions

3. **Linking to resources**
   - Reference skill-patterns.md
   - Link to templates

4. **Minimizing examples**
   - One good example vs. many
   - Reference REFERENCE.md for more

## Anthropic Skill Specification

Required YAML frontmatter fields:

```yaml
---
name: skill-name                    # Required: lowercase, hyphenated
description: Clear description...   # Required: includes trigger keywords
allowed-tools: Read, Write, Edit... # Optional but recommended
---
```

See [resources/skill-patterns.md](resources/skill-patterns.md) for complete specification details.

## Testing

Before deploying a new skill:

- [ ] YAML frontmatter validates
- [ ] Name follows conventions
- [ ] Description includes triggers
- [ ] Under 5k tokens
- [ ] All references work
- [ ] Scripts execute correctly
- [ ] Templates have placeholders
- [ ] Skill loads in Claude Code
- [ ] Workflows execute properly
- [ ] Tools work as expected

## Contributing

When creating new templates or patterns:

1. Follow existing naming conventions
2. Use {{variable}} syntax for placeholders
3. Document all variables
4. Test templates thoroughly
5. Update REFERENCE.md with examples
6. Add to skill-patterns.md if appropriate

## Resources

- **SKILL.md** - Main skill definition
- **REFERENCE.md** - Detailed patterns
- **resources/skill-patterns.md** - Design patterns guide
- **templates/** - Reusable templates
- **scripts/** - Validation and utility scripts

## Support

For issues or questions:

1. Review [REFERENCE.md](REFERENCE.md) for detailed patterns
2. Check [resources/skill-patterns.md](resources/skill-patterns.md) for design guidance
3. Validate with `./scripts/validate-skill.sh`
4. Check YAML frontmatter format
5. Verify naming conventions

## License

Part of the BMAD skill package.

---

**Version:** 1.0.0
**Last Updated:** 2025-12-09
**Maintained By:** BMAD Skills Team
