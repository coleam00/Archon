---
name: 'step-08b-mermaid-business-goals'
description: 'Format business goals nodes with emojis, titles, and key points'

# File References
nextStepFile: './step-08c-mermaid-platform.md'
activityWorkflowFile: '../workflow.md'
---

# Step 25: Format Business Goals Nodes

## STEP GOAL:

Create properly formatted business goals nodes with emojis, ALL CAPS titles, key points, and proper padding for the Mermaid diagram.

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

- 🎯 Focus on formatting business goal nodes following exact template
- 🚫 FORBIDDEN to use HTML tags (bold, italic) in nodes
- 💬 Approach: Systematic node creation following template pattern
- 📋 Each node: starts with `<br/>`, emoji + ALL CAPS title, 3-5 key points, ends with `<br/><br/>`
- 📋 Priority indicated by vertical order (BG0 top), not special formatting

## EXECUTION PROTOCOLS:

- 🎯 Format each business goal as a properly structured node
- 💾 Store business_goals_nodes and business_goals_count
- 📖 Follow exact node structure template
- 🚫 Do not use HTML formatting tags

## CONTEXT BOUNDARIES:

- Available context: Business goals from workshops, diagram structure from step-08a
- Focus: Formatting BG nodes for Mermaid diagram
- Limits: Follow exact template pattern - no custom formatting
- Dependencies: Requires diagram structure from step-08a

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Format Each Business Goal Node

**Node Structure Template:**

```
BGX["<br/>EMOJI TITLE<br/><br/>Point 1<br/>Point 2<br/>Point 3<br/><br/>"]
```

**Required elements per node:**

1. Start with `<br/>` (top padding)
2. Emoji + Title in ALL CAPS
3. Blank line (`<br/><br/>`)
4. 3-5 key points (each on separate line with `<br/>`)
5. End with `<br/><br/>` (bottom padding)

### 2. Choose Appropriate Emoji

Based on goal theme:

- Revenue/Profitability: money bag
- Customer Satisfaction: happy face
- Efficiency/Speed: lightning bolt
- Growth/Expansion: rocket
- Community: star
- Objectives/Metrics: chart
- Partnerships: handshake
- Goals/Targets: target

All business goals use consistent styling. Priority is indicated by vertical order (BG0 first = top priority).

### 3. Verify Rules Checklist

- Node ID follows pattern BG0, BG1, BG2
- Starts with `<br/>`
- Emoji at beginning of title
- Title in ALL CAPS
- Blank line after title (`<br/><br/>`)
- 3-5 key points
- Each point ends with `<br/>`
- Ends with `<br/><br/>`
- No HTML tags (bold, italic)
- Proper quote and bracket closure `"]`

Store business_goals_nodes and business_goals_count.

### 4. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Format Platform Node | [M] Return to Activity Menu"

#### Menu Handling Logic:

- IF C: Load and execute {nextStepFile}
- IF M: Return to {activityWorkflowFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN user selects [C] will you load the next step file. All business goal nodes must be formatted before proceeding.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All business goal nodes formatted following template
- Proper padding at top and bottom
- Emoji + ALL CAPS titles
- 3-5 key points per node
- No HTML tags in any node
- Priority indicated by order, not formatting
- Nodes stored for assembly

### ❌ SYSTEM FAILURE:

- Missing padding
- HTML tags in nodes
- Titles not in ALL CAPS
- Missing or too many key points
- Improper node closure
- Using special formatting for priority

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
