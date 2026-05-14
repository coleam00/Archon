# Skill Creator — End-to-End Tutorial

**Duration**: ~30 minutes
**What you'll build**: A complete `greeting-skill` with script, MENU.yaml, and reference file
**What you'll learn**: The full GDIT spec-driven development workflow applied to skill creation

## Prerequisites

- GDIT framework loaded (you're using it now)
- `~/.kiro/skills/skill-creator/` installed
- Python 3.12+

---

## Phase 1: Setup (~2 min)

**GDIT framework concept**: Spec-driven development — all work starts with specifications.

Create the spec directory for your tutorial skill:

```bash
mkdir -p .kiro/specs/greeting-skill
```

This is where your requirements, design, and tasks live. The GDIT framework workflow is:
**requirements → design → tasks → validate spec → implement → validate output**

---

## Phase 2: Requirements (~5 min)

**GDIT framework concept**: Requirements format, acceptance criteria, user stories.

Create `.kiro/specs/greeting-skill/requirements.md`:

```markdown
# Greeting Skill — Requirements

**Feature**: greeting-skill
**Status**: IN PROGRESS
**Related**: `design.md`, `tasks.md`

---

## REQ-1: Greeting Generation

**As a** user,
**I want** to generate personalized greetings in different formats,
**So that** I can quickly produce greetings for various occasions.

**Acceptance Criteria:**
- Accepts a name parameter (required)
- Accepts a format parameter: formal, casual, celebration (default: casual)
- Returns appropriate greeting text for the selected format
- Handles missing name gracefully with error message

---

## REQ-2: Format Reference

**As a** user,
**I want** a reference of available greeting formats and examples,
**So that** I can choose the right format without trial and error.

**Acceptance Criteria:**
- Documents all available formats with examples
- Available as a reference file loaded on demand
- Includes guidance on when to use each format
```

**Key points:**
- Each REQ has a user story (As a / I want / So that)
- Acceptance criteria are specific and testable
- REQ numbers are sequential

---

## Phase 3: Design (~5 min)

**GDIT framework concept**: Design traceability, correctness properties, implementation mapping.

Create `.kiro/specs/greeting-skill/design.md`:

```markdown
# Greeting Skill — Design

**Feature**: greeting-skill
**Related**: `requirements.md`, `tasks.md`

---

## Script Architecture (REQ-1)

The greeting logic lives in `scripts/greet.py` — a PEP 723 compliant script.

**Usage**: `python3 scripts/greet.py <name> [--format casual|formal|celebration]`

**Behavior:**
1. Parse name argument (required) and --format flag (default: casual)
2. Select greeting template based on format
3. Print formatted greeting to stdout
4. Exit 0 on success, 1 on error

**Correctness Properties:**
- Missing name produces error to stderr and exit code 1
- Invalid format produces error to stderr with list of valid formats
- Output always goes to stdout (composable)
- Script handles KeyboardInterrupt gracefully

**Implemented by**: Task 1

---

## Format Reference (REQ-2)

A reference file at `references/formats.md` documenting available formats.

**Correctness Properties:**
- Every format supported by greet.py is documented
- Each format has at least one example

**Implemented by**: Task 2

---

## MENU.yaml Workflows (REQ-1, REQ-2)

Two workflows:
- `greet`: Run greet.py with parameters
- `list-formats`: Load references/formats.md

**Implemented by**: Task 3
```

**Key points:**
- Design sections reference REQs in headers: `## Section (REQ-N)`
- Each section has `**Correctness Properties:**`
- Each section has `**Implemented by**: Task N`

---

## Phase 4: Tasks (~3 min)

**GDIT framework concept**: Task format, effort tracking, traceability to requirements and design.

Create `.kiro/specs/greeting-skill/tasks.md`:

```markdown
# Greeting Skill — Tasks

**Feature**: greeting-skill
**Related**: `requirements.md`, `design.md`

---

| Task | Story Points (estimate) | Traditional Human LOE | AI-Assisted Estimate |
|------|------------------------|-----------------------|---------------------|
| 1 | 3 | 1.5h | 15m |
| 2 | 1 | 30m | 5m |
| 3 | 2 | 1h | 10m |

---

### Task 1: Implement greet.py script

- [ ] Create scripts/greet.py with PEP 723 metadata
- [ ] Implement argument parsing (name, --format)
- [ ] Implement greeting templates (casual, formal, celebration)
- [ ] Add error handling (missing name, invalid format)
- [ ] Add KeyboardInterrupt handler
- **Addresses**: REQ-1
- **Design**: design.md#script-architecture

---

### Task 2: Create formats reference

- [ ] Create references/formats.md
- [ ] Document casual, formal, celebration formats with examples
- [ ] Include "when to use" guidance for each format
- **Addresses**: REQ-2
- **Design**: design.md#format-reference

---

### Task 3: Write SKILL.md and MENU.yaml

- [ ] Create SKILL.md with frontmatter and body
- [ ] Create MENU.yaml with greet and list-formats workflows
- [ ] Include python_version and script fields in MENU.yaml
- **Addresses**: REQ-1, REQ-2
- **Design**: design.md#menuyaml-workflows
```

**Key points:**
- Every task has `**Addresses**: REQ-N`
- Every task has `**Design**: design.md#anchor`
- Effort tracking table at the top

### Phase 4b: Create model.sysml

**GDIT framework concept**: SysML v2 formal modeling — adds machine-parseable constraints beyond prose.

Create `.kiro/specs/greeting-skill/model.sysml`:

```sysml
package GreetingSkill {

    constraint def NameRequired {
        doc /* REQ-1: Name parameter must be non-empty */
        attribute name : String;
        name->size() >= 1;
    }

    action def GreetWorkflow {
        doc /* REQ-1: Greeting generation with format selection */
        in name : String;
        in format : String;
        out exitCode : Integer;

        action validateInput {
            doc /* Check name is provided */
        }

        then action selectTemplate {
            doc /* Choose greeting template based on format */
        }

        then action printGreeting {
            doc /* Output formatted greeting to stdout */
        }
    }

    part def GreetScript {
        doc /* scripts/greet.py — PEP 723 greeting generator */
        perform action GreetWorkflow;
        satisfy requirement REQ_1;
    }

    part def FormatReference {
        doc /* references/formats.md — format documentation */
        satisfy requirement REQ_2;
    }

    verification def GreetTests {
        doc /* Tests greeting generation with all formats */
        verify requirement REQ_1;
        subject : GreetScript;
    }

    requirement def REQ_1 {
        doc /* Greeting generation with name and format parameters */
    }

    requirement def REQ_2 {
        doc /* Format reference documentation */
    }

    package ComplianceGraph {
        requirement def SSDF_PW_5_1 {
            doc /* NIST 800-218 PW.5.1 | ITSTD5011 §4.1.4, ITHB501C §3.12.1 */
        }
        part InputValidation_PW_5_1 { satisfy requirement SSDF_PW_5_1; }
    }
}
```

**Key points:**
- Constraints express checkable assertions (not prose restatements)
- Action defs model workflow logic with typed inputs/outputs
- `satisfy` links components to requirements
- `verify` links test cases to requirements
- ComplianceGraph maps to NIST 800-218 practices

---

## Phase 5: Validate Spec (~2 min)

**GDIT framework concept**: Quality gates — specs must pass validation before implementation.

Run the spec validator:

```bash
python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/greeting-skill/
```

**Expected output** (all green):
```
✅ File exists: requirements.md
✅ File exists: design.md
✅ File exists: tasks.md
✅ Acceptance criteria: REQ-1
✅ Acceptance criteria: REQ-2
✅ Correctness properties: 3 sections in design
✅ Design → Tasks: 3 'Implemented by' references
✅ REQ coverage: All 2 requirements covered by tasks
✅ Task → REQ: All 3 tasks reference requirements
✅ Task → Design: All 3 tasks reference design sections
✅ READY FOR IMPLEMENTATION
```

**If validation fails**: Read the error messages — they tell you exactly what's wrong and how to fix it. Common issues:
- Missing `**Acceptance Criteria:**` (needs the bold + colon format)
- Task missing `**Addresses**: REQ-N`
- Design anchor doesn't match an actual heading

Fix any issues and re-run until all gates pass.

---

## Phase 6: Implement (~10 min)

**GDIT framework concept**: Scaffolding, script conventions, steering validation.

### Step 6a: Scaffold the skill

```bash
python3 ~/.kiro/skills/skill-creator/scripts/init_skill.py greeting-skill \
  --path ~/.kiro/skills \
  --resources scripts,references \
  --menu
```

### Step 6b: Write greet.py

Replace `~/.kiro/skills/greeting-skill/scripts/example.py` with `scripts/greet.py`:

```python
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Greeting generator — produces personalized greetings in multiple formats."""

import argparse
import sys

FORMATS = {
    "casual": "Hey {name}! 👋 What's up?",
    "formal": "Dear {name}, I hope this message finds you well.",
    "celebration": "🎉 Congratulations, {name}! 🎉",
}


def greet(name, fmt="casual"):
    """Generate a greeting."""
    template = FORMATS.get(fmt)
    if not template:
        valid = ", ".join(sorted(FORMATS.keys()))
        print(f"❌ Invalid format '{fmt}'. Valid: {valid}", file=sys.stderr)
        return 1
    print(f"✅ {template.format(name=name)}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Generate personalized greetings")
    parser.add_argument("name", nargs="?", help="Name to greet")
    parser.add_argument("--format", default="casual", choices=FORMATS.keys(), help="Greeting format")
    args = parser.parse_args()

    if not args.name:
        print("❌ Name is required. Usage: greet.py <name> [--format casual|formal|celebration]", file=sys.stderr)
        return 1

    return greet(args.name, args.format)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n❌ Cancelled", file=sys.stderr)
        sys.exit(1)
```

Delete the example.py placeholder:
```bash
rm ~/.kiro/skills/greeting-skill/scripts/example.py
```

### Step 6c: Write formats reference

Create `~/.kiro/skills/greeting-skill/references/formats.md`:

```markdown
# Greeting Formats

## casual (default)

Friendly, informal greeting. Use for: colleagues, friends, everyday communication.

Example: "Hey Alice! 👋 What's up?"

## formal

Professional, respectful greeting. Use for: business correspondence, first contact, official communication.

Example: "Dear Alice, I hope this message finds you well."

## celebration

Festive, congratulatory greeting. Use for: achievements, milestones, promotions, birthdays.

Example: "🎉 Congratulations, Alice! 🎉"
```

### Step 6d: Write SKILL.md

Replace the generated SKILL.md with:

```markdown
---
name: greeting-skill
description: Generate personalized greetings in multiple formats (casual, formal, celebration). Use when users want to create greetings, welcome messages, or congratulatory text.
metadata:
  author: Tutorial
  version: "1.0.0"
  category: automation
  python_version: ">=3.12"
---

# Greeting Skill

Generate personalized greetings in casual, formal, or celebration format.

## Platform Requirements

- Python 3.12+

## Scripts

| Script | Purpose |
|--------|---------|
| greet.py | Generate greeting with name and format |

## Usage

```bash
python3 scripts/greet.py Alice --format formal
```

See `references/formats.md` for all available formats and when to use each.
```

### Step 6e: Write MENU.yaml

Replace the generated MENU.yaml with:

```yaml
---
skill_name: greeting-skill
menu_version: "1.0"
description: Generate personalized greetings
python_version: ">=3.12"

workflows:
  - id: greet
    label: "Generate Greeting"
    description: "Create a personalized greeting"
    script: scripts/greet.py
    interactive: false
    instructions: |
      Generate a greeting for a person.

      Run: python3 scripts/greet.py <name> --format <casual|formal|celebration>
    parameters:
      - name: person_name
        required: true
        prompt: "Name to greet"
      - name: format
        required: false
        prompt: "Format (casual/formal/celebration)"
        default: "casual"

  - id: list-formats
    label: "List Greeting Formats"
    description: "Show available greeting formats and examples"
    interactive: false
    instructions: |
      Show the user all available greeting formats.

      Read: references/formats.md
    parameters: []
```

### Step 6f: Run steering validation

```bash
# Syntax check
python3 -m py_compile ~/.kiro/skills/greeting-skill/scripts/greet.py

# Lint
ruff check ~/.kiro/skills/greeting-skill/scripts/greet.py

# Secrets scan
gitleaks detect --source ~/.kiro/skills/greeting-skill/scripts/ --no-git --verbose
```

All should pass with zero findings.

---

## Phase 7: Validate & Review (~3 min)

**GDIT framework concept**: Structural validation + quality review.

### Step 7a: Run structural validation

```bash
python3 ~/.kiro/skills/skill-creator/scripts/quick_validate.py ~/.kiro/skills/greeting-skill
```

**Expected**: `✅ Skill is valid!`

### Step 7b: Test the script

```bash
python3 ~/.kiro/skills/greeting-skill/scripts/greet.py Alice
python3 ~/.kiro/skills/greeting-skill/scripts/greet.py Bob --format formal
python3 ~/.kiro/skills/greeting-skill/scripts/greet.py Charlie --format celebration
```

### Step 7c: Run quality review

Load the skill-creator and select the "Review Skill Quality" workflow. Select greeting-skill. The agent will evaluate description quality, progressive disclosure, script quality, and completeness.

---

## 🎉 Tutorial Complete!

You've just created a complete skill using the GDIT spec-driven workflow:

1. ✅ Wrote specifications (requirements → design → tasks)
2. ✅ Validated specs with `validate-spec.py`
3. ✅ Scaffolded with `init_skill.py`
4. ✅ Implemented with proper conventions (PEP 723, emoji output, stderr, KeyboardInterrupt)
5. ✅ Ran steering validation (ruff, gitleaks)
6. ✅ Validated with `quick_validate.py`
7. ✅ Reviewed quality

## Next Steps

- **Customize**: Modify greeting-skill to add more formats or features
- **Delete**: Remove `~/.kiro/skills/greeting-skill/` and `.kiro/specs/greeting-skill/` if you don't need it
- **Create your own**: Use the skill-creator workflows to build a skill for your real use case
- **Publish**: Share your skill via GitHub/GitLab for others to install with skill-installer
