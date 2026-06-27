---
name: 'step-01d-extract-info'
description: 'Extract key information from provided communications and documents to inform the alignment document'

# File References
nextStepFile: './step-01e-detect-starting-point.md'
workflowFile: '../workflow.md'
---

# Step 4: Extract Information from Communications

## STEP GOAL:

Extract key information from the user's provided communications and documents to inform the alignment document sections.

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

- 🎯 Focus only on extracting relevant information from provided materials
- 🚫 FORBIDDEN to copy entire communications verbatim or include personal/irrelevant details
- 💬 Approach: Extract, summarize, and confirm with user
- 📋 Map extracted info to alignment document sections

## EXECUTION PROTOCOLS:

- 🎯 Extract relevant information and map to alignment sections
- 💾 Store extracted information for use in exploration steps
- 📖 Use the extraction guidelines below
- 🚫 Do not include sensitive, outdated, or irrelevant information

## CONTEXT BOUNDARIES:

- Available context: User's provided communications/documents
- Focus: Extracting actionable information for the alignment document
- Limits: Only extract what's relevant to the alignment document sections
- Dependencies: User must have provided communications/documents in step-01c

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Extract Relevant Information from Communications/Documents

Extract relevant information from the communications/documents:

**What to extract**:

- **Realizations mentioned** - What have stakeholders realized or observed?
- **Requirements discussed** - What do they need or want?
- **Concerns raised** - What questions or concerns have they expressed?
- **Context** - Background information about the project
- **Timeline or urgency** - Any deadlines or time-sensitive information
- **Budget or constraints** - Financial or resource limitations mentioned

### 2. Map Extracted Information to Alignment Sections

**Use extracted information**:

- Inform The Realization section (what realizations or observations are mentioned)
- Inform Why It Matters (who is experiencing issues and why it matters)
- Inform Our Commitment (any budget/resource discussions)
- Inform Cost of Inaction (any urgency or consequences mentioned)
- Add context throughout the alignment document

### 3. Apply Extraction Guardrails

**Don't**:

- Copy entire communications or documents verbatim
- Include personal or irrelevant details
- Overwhelm with too much detail
- Use information that's clearly outdated
- Include sensitive information that shouldn't be in the alignment document

### 4. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to step-01e-detect-starting-point"

#### Menu Handling Logic:

- IF C: Load, read entire file, then execute {nextStepFile}
- IF M: Return to {workflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN information has been extracted and confirmed with the user will you then load and read fully `{nextStepFile}` to execute and begin the next step.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Relevant information is extracted and mapped to alignment sections
- Extracted info is concise and actionable
- User confirms the extraction is accurate

### ❌ SYSTEM FAILURE:

- Copying communications verbatim
- Including sensitive or irrelevant details
- Skipping extraction and moving on without processing documents
- Not confirming extracted information with user

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
