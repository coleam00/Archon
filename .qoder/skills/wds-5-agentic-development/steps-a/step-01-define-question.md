---
name: 'step-01-define-question'
description: 'Articulate exactly what you need to understand about the codebase before reading a single file'

# File References
nextStepFile: './step-02-scan-codebase.md'
---

# Step 1: Define Question

## STEP GOAL:

Articulate exactly what you need to understand about the codebase before reading a single file.

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

- 🎯 Focus only on defining clear analysis questions, scope, expected output, and time box
- 🚫 FORBIDDEN to begin scanning or reading any codebase files — that is a later step
- 💬 Approach: Help user articulate their question clearly and set boundaries before any exploration
- 📋 If user provides vague questions, help them sharpen and prioritize

## EXECUTION PROTOCOLS:

- 🎯 Produce a clear, scoped analysis question with defined boundaries
- 💾 Save the question, scope, output format, and time box for subsequent steps
- 📖 Reference the category table and scope options to guide user
- 🚫 Do not open, scan, or explore any code during this step

## CONTEXT BOUNDARIES:

- Available context: User's initial request or motivation for analysis
- Focus: Defining what to analyze and how to scope it
- Limits: No codebase exploration yet — purely planning
- Dependencies: None — this is the first step

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Articulate the Question

Write down what you need to understand. Common analysis questions:

| Category         | Example Questions                                                   |
| ---------------- | ------------------------------------------------------------------- |
| **Architecture** | How is this application structured? What patterns does it use?      |
| **Dependencies** | What does this module depend on? What would break if I change it?   |
| **Patterns**     | What conventions does the team follow? Where are they inconsistent? |
| **Performance**  | Where are the bottlenecks? What queries are expensive?              |
| **Data flow**    | How does data move from user input to database and back?            |
| **Integration**  | What external services does this connect to? How?                   |
| **Security**     | Where is authentication handled? Are there exposed endpoints?       |

Write the question in plain language. If you have multiple questions, prioritize them.

### 2. Define Scope

Determine what is in and out of scope:

- **Entire codebase** — Full architecture review (use for onboarding or documentation)
- **Specific module** — One feature area, service, or package
- **Cross-cutting concern** — Authentication, error handling, logging across the codebase
- **Integration boundary** — How two systems communicate

Be explicit about what you will NOT analyze. Unbounded scope leads to analysis paralysis.

### 3. Define Expected Output

Decide what the analysis should produce:

- **Architecture map** — High-level component diagram with relationships
- **Dependency graph** — Module dependencies, import chains
- **Pattern catalog** — Design patterns used, where, and how consistently
- **API map** — Endpoints, request/response shapes, authentication
- **Data model** — Entity relationships, storage patterns
- **Risk assessment** — Tech debt, security concerns, fragile areas

### 4. Set Time Box

Decide how long the analysis should take. Recommended:

| Scope         | Time Box  |
| ------------- | --------- |
| Single module | 15-30 min |
| Feature area  | 30-60 min |
| Full codebase | 1-2 hours |

If the time box expires, document what you found and what remains unexplored.

### 5. Verify Checklist

- [ ] Question is written in plain language
- [ ] Scope boundaries are defined (what is in, what is out)
- [ ] Expected output format is chosen
- [ ] Time box is set

### 6. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Step 2: Scan Codebase"

#### Menu Handling Logic:

- IF C: Update design log, then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN the user has confirmed a clear question, scope, output format, and time box will you then load and read fully `{nextStepFile}` to execute.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Question is written in plain language
- Scope boundaries are defined (what is in, what is out)
- Expected output format is chosen
- Time box is set

### ❌ SYSTEM FAILURE:

- Beginning codebase exploration before question is defined
- Proceeding without clear scope boundaries
- Skipping time box definition

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
