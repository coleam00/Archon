---
name: 'step-04-verify'
description: 'Confirm the fix works and has not introduced regressions'

# File References
nextStepFile: './step-05-document.md'
---

# Step 4: Verify

## STEP GOAL:

Confirm the fix works and has not introduced regressions.

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

- 🎯 Focus only on re-running reproduction steps, running full regression, testing edge cases, verifying no side effects, and cross-platform checks
- 🚫 FORBIDDEN to add new features or make additional code changes — only verify and fix regressions
- 💬 Approach: Systematic verification with user, testing the fix and all adjacent functionality
- 📋 Any regression must be fixed before proceeding to documentation

## EXECUTION PROTOCOLS:

- 🎯 Fix confirmed working with no regressions
- 💾 Update dialog file with verification results
- 📖 Reference reproduction steps from Step 1 and fix details from Step 3
- 🚫 Do not add features or make non-fix changes

## CONTEXT BOUNDARIES:

- Available context: Reproduction from Step 1; root cause from Step 2; fix from Step 3
- Focus: Comprehensive verification — fix works, no regressions, no side effects
- Limits: No feature additions, only regression fixes if needed
- Dependencies: Step 3 must be complete (fix implemented)

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Re-Run Reproduction Steps

- Follow the exact reproduction steps from Step 01
- Confirm the bug is fully resolved (not partially or intermittently)
- Test on the same environment used for reproduction

### 2. Run Full Regression Tests

- Run the project's test suite (unit tests, integration tests)
- If no automated test suite exists, manually test the core user flows
- Pay extra attention to features that share code with the fixed area

### 3. Check Edge Cases

- Test boundary conditions around the fix:
  - Empty/null/undefined inputs
  - Maximum/minimum values
  - Rapid repeated actions
  - Network errors or slow responses (if applicable)
- Test the exact scenario that was broken, but with slight variations

### 4. Verify No Side Effects

- Check features that are adjacent to or depend on the fixed code
- If the fix changed shared state, verify all consumers of that state
- If the fix changed a utility function, verify all callers
- Compare behavior with baseline (if captured)

### 5. Cross-Platform Check

- If the bug was platform-specific, verify the fix works on that platform
- Also verify the fix does not break other platforms
- Test on relevant viewport sizes if the bug was visual

### 6. Verify Checklist

- [ ] Reproduction steps pass — bug is fixed
- [ ] Test suite passes (all tests green)
- [ ] Edge cases tested around the fix
- [ ] No side effects on related features
- [ ] Cross-platform verification done (if applicable)
- [ ] Dialog file updated with verification results

### 7. Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Step 5: Document"

#### Menu Handling Logic:

- IF C: Update design log, then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN all verification passes with no regressions will you then load and read fully `{nextStepFile}` to execute.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Reproduction steps pass — bug is fixed
- Test suite passes (all tests green)
- Edge cases tested around the fix
- No side effects on related features
- Cross-platform verification done (if applicable)

### ❌ SYSTEM FAILURE:

- Not re-running reproduction steps
- Skipping regression test suite
- Not testing edge cases
- Ignoring side effects on related features
- Proceeding with failing tests

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
