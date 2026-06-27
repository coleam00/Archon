---
name: 'step-03-persona-consistency'
description: 'Validate persona documents match trigger map data and are internally consistent'

# File References
nextStepFile: './step-04-feature-impact-alignment.md'
activityWorkflowFile: '../workflow-validate.md'
---

# Step 3: Persona Consistency Validation

## STEP GOAL:

Verify persona documents match trigger map hub data and are internally consistent: names match, priority levels match, driving forces align, descriptions match, all sections complete, and personas are distinct.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Validation specialist reviewing trigger map completeness, consistency, and strategic alignment
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring validation methodology expertise, user brings product knowledge
- ✅ Maintain thorough and quality-focused tone throughout

### Step-Specific Rules:

- 🎯 Focus on hub-to-document alignment and cross-persona distinctness
- 🚫 FORBIDDEN to approve if names or priority levels mismatch between hub and persona docs
- 💬 Approach: Systematic cross-document comparison
- 📋 Check: name match, priority match, force match, description match, section completeness, cross-persona distinctness
- 📋 Each persona should represent a distinct user type

## EXECUTION PROTOCOLS:

- 🎯 Compare hub data against each persona document
- 💾 Store persona consistency report
- 📖 Verify all required sections present in each document
- 🚫 Do not skip cross-persona distinctness check

## CONTEXT BOUNDARIES:

- Available context: Hub document and all persona documents
- Focus: Cross-document consistency and completeness
- Limits: Validation only - flag mismatches, do not fix
- Dependencies: Requires prioritization integrity validated

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Hub to Persona Document Alignment

For each persona:

- Name matches between hub and persona document
- Priority level matches between hub and persona document
- Driving forces in persona doc match those in hub
- Description in persona doc matches hub summary

### 2. Persona Document Completeness

Each persona document should have all required sections:

- Name and role description
- Behavioral profile (not just demographics)
- Goals and motivations
- Positive driving forces with Product Promises/Answers
- Negative driving forces with Product Promises/Answers
- Priority tier and rationale

### 3. Cross-Persona Distinctness

- Each persona represents a distinct user type
- No significant overlap in driving forces between personas
- Each persona has unique behavioral patterns

### 4. Generate Report

```
## Persona Consistency Report

| Persona | Hub Match | Complete | Distinct | Status |
|---------|-----------|----------|----------|--------|
| [Name] | pass/fail | [X]/[Total] sections | pass/warning | pass/warning/fail |

**Consistency issues:** [list or "None"]
```

### 5. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Feature Impact Alignment | [M] Return to Activity Menu"

#### Menu Handling Logic:

- IF C: Load and execute {nextStepFile}
- IF M: Return to {activityWorkflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN user selects [C] will you load the next step file. Persona consistency report must be generated before proceeding.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All personas compared against hub data
- Name and priority mismatches identified
- Section completeness verified for each document
- Cross-persona distinctness checked
- Overlap in driving forces flagged
- Consistency report generated

### ❌ SYSTEM FAILURE:

- Not comparing against hub data
- Missing section completeness check
- Not checking cross-persona distinctness
- Skipping driving force comparison
- Not generating report

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
