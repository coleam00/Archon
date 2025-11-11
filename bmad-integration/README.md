# BMAD Integration

This directory contains BMAD agent prompts (specialist Rings) that JARVIS can deploy.

## Setup

Copy your BMAD agent prompts here from the Project ORTRTA module:

```bash
# If you have Project ORTRTA installed
cp -r ../project-otrta/bmad/project-ortrta/prompts/* ./agents/

# Or create custom agent prompts following the BMAD format
```

## Agent Structure

Each agent should be a markdown file with the following structure:

```markdown
# Agent Name

## Role
Brief description of the agent's role

## Capabilities
- Capability 1
- Capability 2
- Capability 3

## Instructions
Detailed instructions for the agent...
```

## Available Rings (Project ORTRTA)

1. **Nenya** (Product Manager) - Requirements, stakeholders, user stories
2. **Vilya** (System Architect) - Architecture, design, tech stack
3. **Narya** (Research Analyst) - Research, competitive analysis
4. **Ring of Thrór** (Scrum Master) - Sprint planning, timelines
5. **Fëanor's Hammer** (Developer) - Implementation, code
6. **Nazgûl** (QA) - Testing, quality assurance
7. **Annatar** (UX) - User flows, interface design

## Phase 1 Note

In Phase 1, JARVIS has simplified Ring definitions. In Phase 2, we'll fully integrate with the BMAD ecosystem and support all 47+ specialist agents.
