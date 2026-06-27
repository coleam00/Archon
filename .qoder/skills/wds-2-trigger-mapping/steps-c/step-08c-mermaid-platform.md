---
name: 'step-08c-mermaid-platform'
description: 'Format the central platform node with product name and transformation statement'

# File References
nextStepFile: './step-08d-mermaid-target-groups.md'
activityWorkflowFile: '../workflow.md'
---

# Step 26: Format Platform Node

## STEP GOAL:

Create the central platform node with product name in ALL CAPS, category/tagline, and a multi-line transformation statement.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are Saga the Analyst - creating professional diagram nodes
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring structured facilitation and pattern recognition, user brings business knowledge and user insight
- ✅ Work together as equals in a partnership, not a client-vendor relationship

### Step-Specific Rules:

- 🎯 Focus on creating the central platform node
- 🚫 FORBIDDEN to use HTML tags or skip transformation statement
- 💬 Approach: Emotionally compelling transformation statement spanning 3-5 lines
- 📋 Node ID must be exactly PLATFORM
- 📋 Include category/tagline and multi-line transformation

## EXECUTION PROTOCOLS:

- 🎯 Format platform node following exact template
- 💾 Store platform_node and transformation_statement
- 📖 Transformation statement should describe before->after change
- 🚫 Do not skip any required element

## CONTEXT BOUNDARIES:

- Available context: Product name, vision, transformation goals
- Focus: Central platform node creation
- Limits: Follow exact node structure template
- Dependencies: Requires business goal nodes from step-08b

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Format Platform Node

**Node Structure Template:**

```
PLATFORM["<br/>EMOJI PRODUCT NAME<br/><br/>Category or tagline<br/><br/>Transformation statement<br/>that spans multiple lines<br/>describing the change<br/><br/>"]
```

**Required elements:**

1. Start with `<br/>` (top padding)
2. Emoji + Product name in ALL CAPS
3. Blank line (`<br/><br/>`)
4. Category or tagline
5. Blank line (`<br/><br/>`)
6. Transformation/value statement - break across multiple lines (3-5 lines)
7. End with `<br/><br/>` (bottom padding)

### 2. Craft Transformation Statement

The transformation statement should:

- Describe the before -> after change
- Be emotionally compelling
- Be specific about the transformation
- Span 3-5 lines for readability
- Connect to the strategic vision and transformation goals

### 3. Verify Rules Checklist

- Node ID is exactly `PLATFORM`
- Starts with `<br/>`
- Emoji at beginning
- Product name in ALL CAPS
- Category/tagline included
- Transformation statement spans multiple lines
- Each line ends with `<br/>`
- Ends with `<br/><br/>`
- No HTML tags
- Proper quote and bracket closure `"]`

Store platform_node and transformation_statement.

### 4. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Format Target Groups | [M] Return to Activity Menu"

#### Menu Handling Logic:

- IF C: Load and execute {nextStepFile}
- IF M: Return to {activityWorkflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN user selects [C] will you load the next step file. Platform node must be formatted before proceeding.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Platform node formatted with all required elements
- Transformation statement emotionally compelling and multi-line
- Product name in ALL CAPS with emoji
- Category/tagline included
- Proper padding and closure
- No HTML tags

### ❌ SYSTEM FAILURE:

- Wrong node ID (not PLATFORM)
- Missing transformation statement
- Single-line transformation
- HTML tags in node
- Missing category/tagline
- Improper closure

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
