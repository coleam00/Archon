---
name: 'step-09a-finalize-hub'
description: 'Generate all Trigger Map documentation starting from the hub document'

# File References
nextStepFile: './step-09b-add-cross-references.md'
activityWorkflowFile: '../workflow.md'
---

# Step 32: Generate All Trigger Map Documentation

## STEP GOAL:

Generate the complete trigger map documentation structure including the hub with Mermaid diagram, business goals, persona documents, key insights, and feature impact (if applicable) by orchestrating the document generation workflow.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are Saga the Analyst - creating comprehensive trigger map documentation
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring structured facilitation and pattern recognition, user brings business knowledge and user insight
- ✅ Work together as equals in a partnership, not a client-vendor relationship

### Step-Specific Rules:

- 🎯 Focus on orchestrating complete document generation
- 🚫 FORBIDDEN to skip any required document
- 💬 Approach: Systematic generation following the standard structure
- 📋 Generate: 00-trigger-map.md (hub), 01-Business-Goals.md, persona docs, 05-Key-Insights.md
- 📋 Include 06-Feature-Impact.md if feature workshop was run

## EXECUTION PROTOCOLS:

- 🎯 Execute document generation by loading step-07a-generate-hub.md workflow
- 💾 All documents saved to {output_folder}/B-Trigger-Map/
- 📖 Follow standard trigger map structure
- 🚫 Do not skip any required document

## CONTEXT BOUNDARIES:

- Available context: All workshop outputs, Mermaid diagram
- Focus: Complete documentation generation
- Limits: Follow standard structure exactly
- Dependencies: Requires all workshops completed and diagram generated

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Execute Document Generation

Load and execute the document generation sequence starting with step-07a-generate-hub.md.

This will create all documents following the standard trigger map structure:

- `00-trigger-map.md` (Hub with Mermaid diagram)
- `01-Business-Goals.md`
- `02-XX-Persona.md` (for each persona)
- `05-Key-Insights.md`
- `06-Feature-Impact.md` (if workshop was run)

### 2. Confirm Generation Complete (Completeness Gate)

Verify ALL required documents have been generated:

**Mandatory files in `{output_folder}/B-Trigger-Map/`:**

- [ ] `00-trigger-map.md` — Hub document with Mermaid diagram
- [ ] `01-Business-Goals.md` — Vision + SMART objectives
- [ ] One persona document per target group (`02-XX.md`, `03-XX.md`, etc.)
- [ ] `05-Key-Insights.md` — Strategic insights summary

**Conditional files:**

- [ ] `06-Feature-Impact.md` — Only if feature impact workshop was completed

**Validation rules:**

- Each file must be non-empty (contains actual content, not just headers)
- Hub document must contain a Mermaid code block
- Persona count must match the number of target groups from workshops

**If any file is missing:** Generate the missing file before proceeding. Do NOT skip.

### 3. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Add Cross-References | [M] Return to Activity Menu"

#### Menu Handling Logic:

- IF C: Load and execute {nextStepFile}
- IF M: Return to {activityWorkflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN user selects [C] will you load the next step file. All documents must be generated before proceeding.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All required documents generated
- Documents saved to correct locations
- Standard structure followed
- Hub document includes Mermaid diagram
- Feature Impact included if workshop was run

### ❌ SYSTEM FAILURE:

- Missing required documents
- Documents saved to wrong locations
- Not following standard structure
- Hub missing Mermaid diagram
- Feature Impact missing when workshop was completed

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
