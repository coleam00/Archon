# MENU.yaml Structure and Examples

MENU.yaml provides interactive workflow definitions for skills with multiple distinct procedures.

## When to Include MENU.yaml

Include MENU.yaml when:
- Skill has multiple distinct workflows (3+ different procedures)
- Users benefit from structured menu-driven interaction
- Workflows require parameter collection
- Complex multi-step processes need guidance

Skip MENU.yaml when:
- Skill has simple, single-purpose functionality
- Instructions in SKILL.md are sufficient
- No interactive parameter collection needed

## Basic Structure

```yaml
skill_name: your-skill-name
menu_version: "1.0"
description: Brief skill description
python_version: ">=3.12"

workflows:
  - id: workflow-id
    label: "User-Facing Label"
    description: "What this workflow does"
    script: scripts/command.py
    interactive: false
    instructions: |
      Detailed instructions for the agent.
      
      Steps:
      1. First step
      2. Second step
      3. Third step
      
      Run: python3 scripts/command.py
    parameters:
      - name: param_name
        required: true
        prompt: "User prompt for this parameter"
        secure: false
        default: "optional_default"
```

## Field Definitions

### Top Level
- `skill_name`: Must match SKILL.md frontmatter name
- `menu_version`: Version string (use "1.0")
- `description`: Brief description of skill workflows
- `python_version`: Python version requirement string (e.g., `">=3.12"`). Used by runtime to verify compatibility before executing scripts.

### Workflow Fields
- `id`: Unique identifier (lowercase, hyphens)
- `label`: User-facing workflow name
- `description`: Brief workflow description
- `script`: Relative path to the backing script (e.g., `scripts/select-profile.py`). Enables tooling to validate script existence and provides explicit script-to-workflow linkage. Omit for agent-driven workflows with no script.
- `interactive`: Boolean. Set `true` when the script requires terminal input (e.g., prompts, menus). Set `false` or omit for non-interactive scripts. Tells the agent whether the script needs a TTY.
- `instructions`: Detailed agent instructions (multi-line)
- `parameters`: Array of parameter definitions (optional)

### Parameter Fields
- `name`: Parameter identifier
- `required`: Boolean (true/false)
- `prompt`: User-facing prompt text
- `secure`: Boolean, true for sensitive data like tokens (optional)
- `default`: Default value if not provided (optional)

## Complete Example

```yaml
---
skill_name: gitlab-security-scanning
menu_version: "1.0"
description: Query, remediate, and report on security findings from GitLab scanners
python_version: ">=3.12"

workflows:
  - id: scan-findings
    label: "Scan Security Findings"
    description: "Query GitLab for security findings from all scanners"
    script: scripts/scan.py
    interactive: false
    instructions: |
      Scan active project for security findings.
      
      This will:
      1. Query GitLab API for all vulnerability types
      2. Display findings by scanner type
      3. Show findings by severity
      4. Save results to temp/report-{timestamp}.json
      
      Requires: GitLab API token
      Run: python3 scripts/scan.py
    parameters:
      - name: gitlab_token
        required: true
        prompt: "GitLab API Token"
        secure: true
  
  - id: generate-report
    label: "Generate Compliance Report"
    description: "Generate compliance report for findings"
    script: scripts/report.py
    interactive: false
    instructions: |
      Generate executive compliance report.
      
      Formats: json, markdown, csv
      Output: temp/report-{timestamp}.{format}
      
      Run: python3 scripts/report.py --format markdown
    parameters:
      - name: format
        required: false
        prompt: "Report format (json/markdown/csv)"
        default: "markdown"

# AI Usage Instructions:
# When user loads this skill:
# 1. Present workflows as numbered menu
# 2. When user selects workflow, show instructions
# 3. Prompt for required parameters
# 4. Execute via specified command
```

## Best Practices

1. **Clear instructions**: Include step-by-step guidance in instructions field
2. **Executable commands**: Always specify exact command to run
3. **Parameter prompts**: Make prompts clear and user-friendly
4. **Secure parameters**: Mark sensitive data (tokens, passwords) as secure
5. **Defaults**: Provide sensible defaults for optional parameters
6. **Requirements**: Document prerequisites in instructions
7. **Output locations**: Specify where results are saved

## AI Agent Behavior

When a user says "load [skill-name] skill":
1. Agent reads MENU.yaml
2. Presents workflows as numbered menu
3. User selects workflow by number or name
4. Agent shows detailed instructions
5. Agent prompts for required parameters
6. Agent executes specified command
7. Agent handles output and next steps
