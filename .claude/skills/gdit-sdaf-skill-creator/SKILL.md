---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create a new skill (or update an existing skill) that extends AI agent capabilities with specialized knowledge, workflows, or tool integrations. Works across AI platforms.
---

# Skill Creator

Guide for creating effective skills that work across AI platforms.

## About Skills

Skills are modular, self-contained folders that extend AI agent capabilities by providing
specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific
domains or tasks—they transform a general-purpose agent into a specialized agent
equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share the context window with everything else the agent needs: system prompt, conversation history, other skills' metadata, and the actual user request.

**Default assumption: The agent is already very smart.** Only add context it doesn't already have. Challenge each piece of information: "Does the agent really need this explanation?" and "Does this paragraph justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match the level of specificity to the task's fragility and variability:

**High freedom (text-based instructions)**: Use when multiple approaches are valid, decisions depend on context, or heuristics guide the approach.

**Medium freedom (pseudocode or scripts with parameters)**: Use when a preferred pattern exists, some variation is acceptable, or configuration affects behavior.

**Low freedom (specific scripts, few parameters)**: Use when operations are fragile and error-prone, consistency is critical, or a specific sequence must be followed.

Think of the agent as exploring a path: a narrow bridge with cliffs needs specific guardrails (low freedom), while an open field allows many routes (high freedom).

### Anatomy of a Skill

Every skill consists of a required SKILL.md file and optional bundled resources:

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter metadata (required)
│   │   ├── name: (required)
│   │   └── description: (required)
│   └── Markdown instructions (required)
├── MENU.yaml (optional)
│   └── Interactive workflow definitions
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation intended to be loaded into context as needed
    ├── assets/           - Files used in output (templates, icons, fonts, etc.)
    └── config/           - Skill-level default configuration (JSON/YAML)
```

#### SKILL.md (required)

Every SKILL.md consists of:

- **Frontmatter** (YAML): Contains `name` and `description` fields. These are the only fields that the agent reads to determine when the skill gets used, thus it is very important to be clear and comprehensive in describing what the skill is, and when it should be used.
- **Body** (Markdown): Instructions and guidance for using the skill. Only loaded AFTER the skill triggers (if at all).

#### MENU.yaml (optional)

Interactive workflow definitions for structured multi-step processes:

- **Purpose**: Provides menu-driven workflows when users load the skill interactively
- **Structure**: YAML format with workflow definitions, parameters, and instructions
- **When to include**: For skills with multiple distinct workflows or complex procedures
- **Documentation**: See `references/menu_yaml.md` for complete structure and examples
- **Example**: See existing skills like `gitlab-security-scanning` or `aws-security-remediation`

Basic structure:
```yaml
skill_name: your-skill-name
menu_version: "1.0"
description: Brief description

workflows:
  - id: workflow-id
    label: "User-Facing Label"
    description: "What this workflow does"
    instructions: |
      Detailed instructions for the agent
    parameters:
      - name: param_name
        required: true
        prompt: "User prompt"
```

#### Bundled Resources (optional)

##### Scripts (`scripts/`)

Executable code (Python/Bash/etc.) for tasks that require deterministic reliability or are repeatedly rewritten.

- **When to include**: When the same code is being rewritten repeatedly or deterministic reliability is needed
- **Example**: `scripts/rotate_pdf.py` for PDF rotation tasks
- **Benefits**: Token efficient, deterministic, may be executed without loading into context
- **Python requirement**: All Python scripts must include PEP 723 inline metadata for Python 3.12+ compatibility (no external dependencies)
- **Note**: Scripts may still need to be read by the agent for patching or environment-specific adjustments

##### References (`references/`)

Documentation and reference material intended to be loaded as needed into context to inform the agent's process and thinking.

- **When to include**: For documentation that the agent should reference while working
- **Examples**: `references/finance.md` for financial schemas, `references/mnda.md` for company NDA template, `references/policies.md` for company policies, `references/api_docs.md` for API specifications
- **Use cases**: Database schemas, API documentation, domain knowledge, company policies, detailed workflow guides
- **Benefits**: Keeps SKILL.md lean, loaded only when the agent determines it's needed
- **Best practice**: If files are large (>10k words), include grep search patterns in SKILL.md
- **Avoid duplication**: Information should live in either SKILL.md or references files, not both. Prefer references files for detailed information unless it's truly core to the skill—this keeps SKILL.md lean while making information discoverable without hogging the context window. Keep only essential procedural instructions and workflow guidance in SKILL.md; move detailed reference material, schemas, and examples to references files.

##### Assets (`assets/`)

Files not intended to be loaded into context, but rather used within the output the agent produces.

- **When to include**: When the skill needs files that will be used in the final output
- **Examples**: `assets/logo.png` for brand assets, `assets/slides.pptx` for PowerPoint templates, `assets/frontend-template/` for HTML/React boilerplate, `assets/font.ttf` for typography
- **Use cases**: Templates, images, icons, boilerplate code, fonts, sample documents that get copied or modified
- **Benefits**: Separates output resources from documentation, enables the agent to use files without loading them into context

#### What to Not Include in a Skill

A skill should only contain essential files that directly support its functionality. Do NOT create extraneous documentation or auxiliary files, including:

- README.md
- INSTALLATION_GUIDE.md
- QUICK_REFERENCE.md
- CHANGELOG.md
- etc.

The skill should only contain the information needed for an AI agent to do the job at hand. It should not contain auxiliary context about the process that went into creating it, setup and testing procedures, user-facing documentation, etc. Creating additional documentation files just adds clutter and confusion.

### Progressive Disclosure Design Principle

Skills use a three-level loading system to manage context efficiently:

1. **Metadata (name + description)** - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<5k words)
3. **Bundled resources** - As needed by the agent (Unlimited because scripts can be executed without reading into context window)

#### Progressive Disclosure Patterns

Keep SKILL.md body to the essentials and under 500 lines to minimize context bloat. Split content into separate files when approaching this limit. When splitting out content into other files, it is very important to reference them from SKILL.md and describe clearly when to read them, to ensure the reader of the skill knows they exist and when to use them.

**Key principle:** When a skill supports multiple variations, frameworks, or options, keep only the core workflow and selection guidance in SKILL.md. Move variant-specific details (patterns, examples, configuration) into separate reference files.

**Pattern 1: High-level guide with references**

```markdown
# PDF Processing

## Quick start

Extract text with pdfplumber:
[code example]

## Advanced features

- **Form filling**: See [FORMS.md](FORMS.md) for complete guide
- **API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
- **Examples**: See [EXAMPLES.md](EXAMPLES.md) for common patterns
```

the agent loads FORMS.md, REFERENCE.md, or EXAMPLES.md only when needed.

**Pattern 2: Domain-specific organization**

For Skills with multiple domains, organize content by domain to avoid loading irrelevant context:

```
bigquery-skill/
├── SKILL.md (overview and navigation)
└── reference/
    ├── finance.md (revenue, billing metrics)
    ├── sales.md (opportunities, pipeline)
    ├── product.md (API usage, features)
    └── marketing.md (campaigns, attribution)
```

When a user asks about sales metrics, the agent only reads sales.md.

Similarly, for skills supporting multiple frameworks or variants, organize by variant:

```
cloud-deploy/
├── SKILL.md (workflow + provider selection)
└── references/
    ├── aws.md (AWS deployment patterns)
    ├── gcp.md (GCP deployment patterns)
    └── azure.md (Azure deployment patterns)
```

When the user chooses AWS, the agent only reads aws.md.

**Pattern 3: Conditional details**

Show basic content, link to advanced content:

```markdown
# DOCX Processing

## Creating documents

Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).

## Editing documents

For simple edits, modify the XML directly.

**For tracked changes**: See [REDLINING.md](REDLINING.md)
**For OOXML details**: See [OOXML.md](OOXML.md)
```

the agent reads REDLINING.md or OOXML.md only when the user needs those features.

**Important guidelines:**

- **Avoid deeply nested references** - Keep references one level deep from SKILL.md. All reference files should link directly from SKILL.md.
- **Structure longer reference files** - For files longer than 100 lines, include a table of contents at the top so the agent can see the full scope when previewing.

## Skill Creation Process

Skill creation involves these steps:

1. Understand the skill with concrete examples
2. Plan reusable skill contents (scripts, references, assets)
3. Initialize the skill (run init_skill.py)
4. Edit the skill (implement resources and write SKILL.md/MENU.yaml)
5. Validate the skill (run quick_validate.py)
6. Iterate based on real usage

Follow these steps in order, skipping only if there is a clear reason why they are not applicable.

For interactive workflow guidance, say "load skill-creator skill" to access the menu.

### Skill Naming

- Use lowercase letters, digits, and hyphens only; normalize user-provided titles to hyphen-case (e.g., "Plan Mode" -> `plan-mode`).
- When generating names, generate a name under 64 characters (letters, digits, hyphens).
- Prefer short, verb-led phrases that describe the action.
- Namespace by tool when it improves clarity or triggering (e.g., `gh-address-comments`, `linear-address-issue`).
- Name the skill folder exactly after the skill name.

### Step 1: Understanding the Skill with Concrete Examples

Skip this step only when the skill's usage patterns are already clearly understood. It remains valuable even when working with an existing skill.

To create an effective skill, clearly understand concrete examples of how the skill will be used. This understanding can come from either direct user examples or generated examples that are validated with user feedback.

For example, when building an image-editor skill, relevant questions include:

- "What functionality should the image-editor skill support? Editing, rotating, anything else?"
- "Can you give some examples of how this skill would be used?"
- "I can imagine users asking for things like 'Remove the red-eye from this image' or 'Rotate this image'. Are there other ways you imagine this skill being used?"
- "What would a user say that should trigger this skill?"

To avoid overwhelming users, avoid asking too many questions in a single message. Start with the most important questions and follow up as needed for better effectiveness.

Conclude this step when there is a clear sense of the functionality the skill should support.

### Step 2: Planning the Reusable Skill Contents

To turn concrete examples into an effective skill, analyze each example by:

1. Considering how to execute on the example from scratch
2. Identifying what scripts, references, and assets would be helpful when executing these workflows repeatedly

Example: When building a `pdf-editor` skill to handle queries like "Help me rotate this PDF," the analysis shows:

1. Rotating a PDF requires re-writing the same code each time
2. A `scripts/rotate_pdf.py` script would be helpful to store in the skill

Example: When designing a `frontend-webapp-builder` skill for queries like "Build me a todo app" or "Build me a dashboard to track my steps," the analysis shows:

1. Writing a frontend webapp requires the same boilerplate HTML/React each time
2. An `assets/hello-world/` template containing the boilerplate HTML/React project files would be helpful to store in the skill

Example: When building a `big-query` skill to handle queries like "How many users have logged in today?" the analysis shows:

1. Querying BigQuery requires re-discovering the table schemas and relationships each time
2. A `references/schema.md` file documenting the table schemas would be helpful to store in the skill

To establish the skill's contents, analyze each concrete example to create a list of the reusable resources to include: scripts, references, and assets.

### Step 3: Initializing the Skill

At this point, it is time to actually create the skill.

Skip this step only if the skill being developed already exists. In this case, continue to the next step.

When creating a new skill from scratch, always run the `init_skill.py` script. The script conveniently generates a new template skill directory that automatically includes everything a skill requires, making the skill creation process much more efficient and reliable.

Usage:

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--menu] [--examples]
```

Examples:

```bash
scripts/init_skill.py my-skill --path .kiro/skills
scripts/init_skill.py my-skill --path .kiro/skills --resources scripts,references
scripts/init_skill.py my-skill --path .kiro/skills --resources scripts --menu
scripts/init_skill.py my-skill --path .kiro/skills --resources scripts --examples
```

The script:

- Creates the skill directory at the specified path
- Generates a SKILL.md template with proper frontmatter and TODO placeholders
- Optionally creates MENU.yaml template when `--menu` is set
- Optionally creates resource directories based on `--resources`
- Optionally adds example files when `--examples` is set

After initialization, customize the SKILL.md and add resources as needed. If you used `--examples`, replace or delete placeholder files.

### Step 4: Edit the Skill

When editing the (newly-generated or existing) skill, remember that the skill is being created for another instance of the agent to use. Include information that would be beneficial and non-obvious to the agent. Consider what procedural knowledge, domain-specific details, or reusable assets would help another agent instance execute these tasks more effectively.

#### Start with Reusable Skill Contents

To begin implementation, start with the reusable resources identified above: `scripts/`, `references/`, and `assets/` files. Note that this step may require user input. For example, when implementing a `brand-guidelines` skill, the user may need to provide brand assets or templates to store in `assets/`, or documentation to store in `references/`.

Added scripts must be tested by actually running them to ensure there are no bugs and that the output matches what is expected. If there are many similar scripts, only a representative sample needs to be tested to ensure confidence that they all work while balancing time to completion.

**Python Script Requirements (PEP 723):**

All Python scripts must include inline metadata for Python 3.12+ compatibility with no external dependencies:

```python
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
```

This ensures scripts work across different AI platforms without requiring separate dependency management.

**Script Output Conventions:**

All scripts should follow these output conventions for ecosystem consistency:

- Success messages: `print("✅ ...")` → stdout
- Error messages: `print("❌ ...", file=sys.stderr)` → stderr
- Warnings: `print("⚠️  ...", file=sys.stderr)` → stderr
- Info messages: `print("ℹ️  ...")` → stdout
- Always handle `KeyboardInterrupt` gracefully (no traceback):
  ```python
  if __name__ == "__main__":
      try:
          sys.exit(main())
      except KeyboardInterrupt:
          print("\n❌ Cancelled", file=sys.stderr)
          sys.exit(1)
  ```

Routing errors to stderr enables piping/composability — error messages won't corrupt piped output.

**Library Modules vs Executable Scripts:**

Multi-script skills often have shared library modules alongside executable scripts. The conventions:

- **Executable scripts**: `kebab-case.py` — include shebang (`#!/usr/bin/env python3`), PEP 723 metadata, and `if __name__ == "__main__"` block. These are the entry points.
- **Library modules**: `underscore_case.py` — no shebang, no PEP 723 metadata, no `if __name__ == "__main__"`. These are imported by executable scripts.

The validator (`quick_validate.py`) only checks PEP 723 compliance on files containing `if __name__ == "__main__"`. Library modules are automatically exempt.

Example structure:
```
scripts/
├── commit-and-mr.py        # Executable (PEP 723 + shebang)
├── skill_config.py          # Library module (no PEP 723)
└── credential_manager.py    # Library module (no PEP 723)
```

**Dependencies:**

When the standard library is insufficient, dependencies are acceptable. Use `>=` minimum version pinning:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
#   "rich>=13.0.0",
# ]
# ///
```

Keep the dependency list minimal. Prefer standard library solutions when practical.

**Script Safety Patterns:**

For scripts that write to external systems or perform destructive operations:

- **`--dry-run` flag**: Preview changes without writing. Always support this for scripts that modify external state.
  ```python
  parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
  if args.dry_run:
      print(f"ℹ️  [DRY RUN] Would write {count} item(s). No changes made.")
      return
  ```

- **Confirmation prompt**: Ask before destructive actions.
  ```python
  confirm = input(f"Write {count} item(s)? (y/n): ").strip().lower()
  if confirm != "y":
      print("ℹ️  Cancelled.")
      return
  ```

**Non-Interactive Mode:**

Every script should support full CLI flag mode so it can be called without running an interactive setup workflow first. This enables automation, piping, and agent-driven execution.

```bash
# Interactive (prompts user):
python3 ~/.kiro/skills/skill-creator/scripts/scan-report.py

# Non-interactive (all params via flags):
python3 ~/.kiro/skills/skill-creator/scripts/scan-report.py --profile prod --pipeline my-app --format json
```

Principle: If a script has an interactive setup step, expose the same configuration as CLI flags so the setup can be bypassed.

**Credential Handling:**

Skills that handle API tokens or cloud credentials must isolate secrets from the project directory:

Where to store:
- AWS credentials: Use named profiles (`~/.aws/credentials`, pass via `--profile` flag)
- API tokens: Use `~/.gdit-sdaf-secrets/<skill-name>/` (outside project, `0o600` permissions)
- Environment variables: For CI/CD and ephemeral contexts

Where NOT to store:
- ❌ In `config/` directory (may be committed to version control)
- ❌ Hardcoded in scripts
- ❌ In `.env` files within the project directory

Referencing from scripts:
```python
import os
token = os.environ.get("GITLAB_TOKEN") or read_from_secrets_file()
```

Use `--profile` or `--token` CLI flags for explicit credential passing.

**Configuration (`config/` directory):**

For skills with configurable defaults, use a `config/` directory:

```
skill-name/
└── config/
    └── config.json    # {"default_branch": "main", "sync_strategy": "rebase"}
```

**Config priority chain** (highest wins): CLI args > project.yaml > skill `config/` > auto-detect

This ensures users can override skill defaults at multiple levels without editing the skill itself.

**Runtime State:**

For multi-script skills that share state between invocations:

- State files (e.g., `.session.json`): `.gitignored`, restricted to owner permissions (`0o600` on Unix)
- Temp directories: Create with `0o700` permissions, include a `.gitignore` with `*\n` to prevent accidental commits
- Cleanup: Use `atexit` and signal handlers to remove temp files on exit/interrupt

```python
import os, sys
from pathlib import Path

# State file with restricted permissions
state_file = Path("temp/.session.json")
state_file.write_text(json.dumps(data))
if sys.platform != "win32":
    os.chmod(state_file, 0o600)

# Temp directory pattern
temp_dir = Path("temp")
os.makedirs(temp_dir, mode=0o700, exist_ok=True)
(temp_dir / ".gitignore").write_text("*\n")
```

If you used `--examples`, delete any placeholder files that are not needed for the skill. Only create resource directories that are actually required.

#### Update SKILL.md and MENU.yaml

**Writing Guidelines:** Always use imperative/infinitive form.

##### Frontmatter

Write the YAML frontmatter with required and optional fields:

**Required:**
- `name`: The skill name
- `description`: This is the primary triggering mechanism for your skill, and helps the agent understand when to use the skill.
  - Include both what the Skill does and specific triggers/contexts for when to use it.
  - Include all "when to use" information here - Not in the body. The body is only loaded after triggering, so "When to Use This Skill" sections in the body are not helpful to the agent.
  - Example description for a `docx` skill: "Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. Use when the agent needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks"

**Optional:**
- `license`: License type (e.g., MIT)
- `compatibility`: Environment requirements, dependencies, platform constraints
- `allowed-tools`: Tool permissions for restricted environments (see syntax below)
- `metadata`: Additional skill metadata for discovery and version tracking (see sub-fields below)

**`allowed-tools` syntax:**

Restricts which tools the agent can use when this skill is active. Space-separated permissions:
- `Bash(command:pattern)` — Allow specific bash commands (glob patterns)
- `Read` — Allow file reading
- `Write` — Allow file writing

Example: `allowed-tools: Bash(git:*) Bash(python3:*) Read Write`

Include when: skill handles credentials, performs destructive operations, or should be sandboxed to prevent unintended side effects.

**`metadata` sub-fields:**

```yaml
metadata:
  author: Your Name
  version: "1.0.0"        # semver — read from project VERSION file when available
  category: development   # single word: development, security, automation, documentation
  tags: skills, creation, scaffolding   # comma-separated discovery keywords
  python_version: ">=3.12"
```

##### Body

Write instructions for using the skill and its bundled resources.

**Recommended Body Sections** (include when applicable):

- `## Platform Requirements` — List Python version, external tools, AWS/cloud dependencies, or other prerequisites. Include when the skill has runtime requirements beyond Python stdlib.
- `## Security` — Document security posture: file permissions, credential handling, what data is stored/transmitted. Include when the skill handles sensitive data or writes to external systems.
- `## Scripts` — Inventory table with Script | Purpose columns for quick orientation. Include when the skill has 2+ scripts.

These are recommendations, not requirements. Simple single-script skills may not need any of these.

##### MENU.yaml (if created)

Define interactive workflows with:
- Clear workflow IDs and labels
- Detailed instructions for each workflow
- Required and optional parameters
- Command execution patterns

See existing skills (gitlab-security-scanning, aws-security-remediation) for examples.

### Step 5: Validate the Skill

Once development of the skill is complete, validate the skill folder to catch basic issues early:

```bash
scripts/quick_validate.py <path/to/skill-folder>
```

The validation script checks YAML frontmatter format, required fields, and naming rules. If validation fails, fix the reported issues and run the command again.

### Step 6: Iterate

After testing the skill, users may request improvements. Often this happens right after using the skill, with fresh context of how the skill performed.

**Iteration workflow:**

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Identify how SKILL.md or bundled resources should be updated
4. Implement changes and test again

### Updating an Existing Skill

Use the "Update Existing Skill" workflow (option 5 in the menu) for guided updates. This workflow:

1. Lists installed skills and lets you select one
2. Shows current structure (frontmatter, workflows, resources)
3. Offers update categories: frontmatter, body, workflows, scripts, references, assets
4. Applies changes non-destructively
5. Validates after updates via `quick_validate.py`

**Update categories and when to use each:**

- **Frontmatter**: Change description (triggering), add metadata fields
- **SKILL.md body**: Improve instructions, add examples, restructure for progressive disclosure
- **MENU.yaml workflows**: Add new workflows, modify instructions, adjust parameters
- **Scripts**: Fix bugs, add new automation, update PEP 723 metadata
- **References**: Update documentation, add new reference files
- **Assets**: Add/replace templates, icons, or output files

After any update, always run validation:

```bash
scripts/quick_validate.py <path/to/skill-folder>
```

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/skill-creator/scripts/`.
