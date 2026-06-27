---
name: 'step-05k-contract-approval'
description: 'Build Section 11 Approval with signature lines for both parties'

# File References
nextStepFile: './step-05l-finalize-contract.md'
workflowFile: '../workflow.md'
---

# Step 33: Build Section 11 - Approval

## STEP GOAL:

Build the Approval section with formal signature lines for both parties to make the contract legally binding.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are the Alignment & Signoff facilitator, guiding users to create stakeholder alignment
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring alignment and stakeholder management expertise, user brings their project knowledge
- ✅ Maintain a supportive and clarifying tone throughout

### Step-Specific Rules:

- 🎯 Focus only on building the Approval section with signature lines
- 🚫 FORBIDDEN to skip gathering party names for signatures
- 💬 Approach: Gather names and roles, create formal signature block
- 📋 Makes the contract legally binding

## EXECUTION PROTOCOLS:

- 🎯 Build Approval section with signature lines
- 💾 Add to contract document
- 📖 Gather party names and roles
- 🚫 Do not use placeholder names without asking

## CONTEXT BOUNDARIES:

- Available context: All contract sections 1-10, signoff type
- Focus: Contract Section 11 - Approval
- Limits: Signature block only
- Dependencies: step-05j must be completed

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Build Section 11: Approval

**Section 11: Approval**

**Background**: Formal signoff

**What it does**: Signature lines for both parties

**Purpose**: Makes the contract legally binding

**Content**:

- Client and contractor names
- Signature lines
- Date fields

**For Project Contract**:

- Client signature
- Contractor signature

**For Service Agreement**:

- Client/Owner signature
- Service Provider signature

### 2. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to step-05l-finalize-contract"

#### Menu Handling Logic:

- IF C: Load, read entire file, then execute {nextStepFile}
- IF M: Return to {workflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN the Approval section is built with correct party names will you then load and read fully `{nextStepFile}` to execute and begin the next step.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Signature lines are created for both parties
- Party names and roles are correct
- Date fields are included

### ❌ SYSTEM FAILURE:

- Using placeholder names without asking
- Missing signature lines for either party
- Skipping this section

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
