---
name: 'step-05f-contract-availability'
description: 'Build Section 6 Availability for retainer contracts defining response times and working hours'

# File References
nextStepFile: './step-05g-contract-confidentiality.md'
workflowFile: '../workflow.md'
---

# Step 28: Build Section 6 - Availability (Retainer Only)

## STEP GOAL:

Build the Availability section for retainer contracts, defining when the contractor is available, response times, and working hours expectations.

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

- 🎯 Focus only on building the Availability section (retainer only)
- 🚫 FORBIDDEN to set availability expectations without user input
- 💬 Approach: Ask about business hours, response times, meeting availability
- 📋 Only applies to retainer model - skip for other models

## EXECUTION PROTOCOLS:

- 🎯 Build Availability section for retainer contracts
- 💾 Add to contract document
- 📖 This section only applies to retainer model
- 🚫 Do not assume availability expectations

## CONTEXT BOUNDARIES:

- Available context: Business model (retainer), contract sections 1-5
- Focus: Contract Section 6 - Availability
- Limits: Retainer contracts only
- Dependencies: step-05e must be completed

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Build Section 6: Availability (Only for Retainer model)

**Section 6: Availability** (Only for Retainer model)

**Background**: Defines when contractor is available for retainer work

**What it does**: Sets expectations for response times, working hours, availability windows

**Purpose**: Ensures client knows when they can expect work to be done

**Why this matters**:

- Retainer clients need to know when contractor is available
- Sets realistic expectations for response times
- Prevents misunderstandings about availability

**What to include**:

- **Business hours**: (e.g., "Monday-Friday, 9am-5pm EST")
- **Response time**: (e.g., "2-3 business days for non-urgent requests")
- **Availability for meetings**: (e.g., "Available for scheduled calls during business hours")
- **Urgent requests**: (e.g., "Urgent requests may incur additional fees")

**What to ask user**: "What availability expectations do you have? What response times work for you?"

**Content**: Define availability expectations based on retainer agreement

### 2. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to step-05g-contract-confidentiality"

#### Menu Handling Logic:

- IF C: Load, read entire file, then execute {nextStepFile}
- IF M: Return to {workflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN the Availability section is built (if applicable) will you then load and read fully `{nextStepFile}` to execute and begin the next step.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Availability expectations are clearly defined for retainer
- Business hours, response times, and meeting availability are captured
- User confirms the expectations are realistic

### ❌ SYSTEM FAILURE:

- Setting availability expectations without user input
- Applying this section to non-retainer contracts
- Skipping key availability definitions

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
