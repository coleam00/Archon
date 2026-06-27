---
name: 'step-01-identify-target'
description: 'Define what to reverse engineer, how to access it, and what to extract'

# File References
nextStepFile: './step-02-explore-and-capture.md'
---

# Step 1: Identify Target

## STEP GOAL:

Define what to reverse engineer, how to access it, and what to extract.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are an Implementation Partner guiding structured development activities
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring software development methodology expertise, user brings domain knowledge and codebase familiarity
- ✅ Maintain clear and structured tone throughout

### Step-Specific Rules:

- 🎯 Focus only on defining the target, determining access method, defining extraction goals, and documenting the target overview
- 🚫 FORBIDDEN to begin exploring or capturing the target — that is the next step
- 💬 Approach: Help user clearly define what they want to reverse engineer and what they need from it
- 📋 Access method must be verified before proceeding

## EXECUTION PROTOCOLS:

- 🎯 Clear target definition with access method and extraction goals
- 💾 Document target overview in dialog file
- 📖 Reference the target type table and extraction goals checklist
- 🚫 Do not begin exploring or capturing any content

## CONTEXT BOUNDARIES:

- Available context: User's initial request or target description
- Focus: Target identification — what, how, and what to extract
- Limits: No exploration, no capturing
- Dependencies: None — this is the first step

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Define the Target

Identify what you are reverse engineering:

| Target Type           | Examples                                                  |
| --------------------- | --------------------------------------------------------- |
| **Website**           | Public marketing site, SaaS application, e-commerce store |
| **Web application**   | Dashboard, admin panel, booking system                    |
| **Component library** | Design system documentation site, Storybook instance      |
| **Mobile app**        | iOS/Android app (via screenshots or simulator)            |
| **Source code**       | Your own codebase, open source project                    |

Write a clear target description:

```
Target: [Name / URL / Project]
Type: [Website / Web app / Component library / Mobile app / Source code]
Owner: [Own product / Client product / Public / Competitor]
```

### 2. Determine Access Method

How will you explore the target?

| Access Method     | When to Use                                     | Tools                       |
| ----------------- | ----------------------------------------------- | --------------------------- |
| **URL (browser)** | Public websites, web apps with demo             | Puppeteer, browser DevTools |
| **Source code**   | Own codebase, open source                       | File reading, code analysis |
| **Screenshots**   | No live access, mobile apps, provided by client | Image analysis              |
| **Combination**   | Source code + live URL                          | Both code and browser       |

Note any access limitations (login required, rate limits, geo-restrictions).

### 3. Define Extraction Goals

What do you need to extract? Check all that apply:

- [ ] **Page specifications** — Layout, structure, content for each page
- [ ] **Design system** — Colors, typography, spacing, shadows, tokens
- [ ] **Component inventory** — Reusable UI components, variants, states
- [ ] **Content strategy** — Copy patterns, tone, content hierarchy
- [ ] **Architecture** — Tech stack, routing, data flow (requires source access)
- [ ] **User flows** — Multi-page journeys, interaction patterns
- [ ] **All of the above** — Full extraction for rebuild or migration

### 4. Document Target Overview

Create a brief overview to guide the exploration:

```
Target Overview:
- Name: [Name]
- URL: [URL or "source code at /path/"]
- Access: [Browser / Source / Screenshots]
- Goals: [What to extract]
- Output language: [Language for generated specs]
- Pages estimated: [Rough count if known]
- Notes: [Login required? Special states? Known complexity?]
```

### 5. Verify Checklist

- [ ] Target clearly identified with name and type
- [ ] Access method determined and verified (URL loads, source exists, screenshots provided)
- [ ] Extraction goals defined
- [ ] Target overview documented

### 6. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Step 2: Explore and Capture"

#### Menu Handling Logic:

- IF C: Update design log, then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN the target is defined with access method verified and extraction goals documented will you then load and read fully `{nextStepFile}` to execute.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Target clearly identified with name and type
- Access method determined and verified
- Extraction goals defined
- Target overview documented

### ❌ SYSTEM FAILURE:

- Beginning exploration before target is fully defined
- Not verifying access method
- Not defining extraction goals
- Skipping target documentation

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
