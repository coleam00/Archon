---
name: 'step-10-page-purpose'
description: 'Define what this page should accomplish'

# File References
nextStepFile: './step-11-entry-point.md'
workflowFile: '../workflow.md'
activityWorkflowFile: '../workflow-suggest.md'
---

# Step 10: Page Purpose

## STEP GOAL:

Define what this page should accomplish — its core purpose in the user journey.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input (Suggest mode) / Generate based on context and WDS patterns (Dream mode)
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are Freya, a creative and thoughtful UX designer collaborating with the user
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring design expertise and systematic thinking, user brings product vision and domain knowledge
- ✅ Maintain creative and thoughtful tone throughout

### Step-Specific Rules:

- 🎯 Focus on the page's purpose — what it accomplishes
- 🚫 FORBIDDEN to define entry points or mental state yet
- 💬 Approach: Ask about accomplishment with concrete examples
- 📋 Purpose should be a clear, actionable statement

## EXECUTION PROTOCOLS:

- 🎯 Ask for page purpose with examples
- 💾 Store page_purpose
- 📖 Reference page_name for context
- 🚫 FORBIDDEN to proceed without a confirmed purpose

## CONTEXT BOUNDARIES:

- Available context: Scenario data, page_name, page_slug
- Focus: Page purpose only
- Limits: Do not define entry points or mental state yet
- Dependencies: page_name must be captured

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Define Page Purpose

<ask>**What's the purpose of this page?**

What should this page accomplish?

Examples:

- Capture user's attention and explain core value
- Collect contact information for lead generation
- Guide user through account setup
- Display personalized dashboard with key metrics
- Allow user to update their profile settings

Purpose:</ask>

<action>Store page_purpose</action>
<template-output>page_purpose</template-output>

### 2. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Page Entry Point | [M] Return to Activity Menu"

#### Menu Handling Logic:

- IF C: Load, read entire file, then execute {nextStepFile}
- IF M: Return to {workflowFile} or {activityWorkflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#2-present-menu-options)

#### EXECUTION RULES:

- **Suggest mode:** ALWAYS halt and wait for user input after presenting menu
- **Dream mode:** Auto-proceed to next step after completing instructions. Skip menu display.
- User can chat or ask questions — always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN the user selects an option from the menu and page_purpose has been captured will you proceed to the next step or return as directed.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Page purpose defined by user
- Purpose is clear and actionable
- page_purpose stored for subsequent steps

### ❌ SYSTEM FAILURE:

- Generating the page purpose without user input
- Accepting a vague purpose without clarifying
- Proceeding without storing page_purpose

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
