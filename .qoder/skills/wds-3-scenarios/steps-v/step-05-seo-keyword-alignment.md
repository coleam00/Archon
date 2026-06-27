---
name: step-05-seo-keyword-alignment
description: Verify that scenario pages align with the SEO keyword strategy defined in Phase 1

# File References
workflowFile: '../workflow.md'
---

# Validation Step 5: SEO Keyword Alignment

## STEP GOAL:

Verify that scenario pages align with the SEO keyword strategy defined in Phase 1, compile results from all 5 validation steps into a final report, and save the report to the output folder.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Validation Specialist reviewing scenario quality, coverage, and consistency
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring validation expertise and quality standards knowledge, user brings project context, together we ensure scenario quality meets WDS standards
- ✅ Maintain thorough analytical tone throughout

### Step-Specific Rules:

- 🎯 Focus on SEO keyword alignment and final validation report compilation
- 🚫 FORBIDDEN to modify any scenario files during validation
- 💬 Approach: Check keyword mapping and compile all validation results
- 📋 If no SEO keyword map exists, note as gap and proceed to final report

## EXECUTION PROTOCOLS:

- 📖 Load SEO keyword map from Phase 1 output
- 🔗 Map keywords to scenario pages
- 📊 Compile final validation report from all 5 steps
- 💾 Save report to output folder
- 🚫 FORBIDDEN to skip the final report compilation

## CONTEXT BOUNDARIES:

- Available context: All scenario outlines, Phase 1 SEO data, results from validation steps 1-4
- Focus: SEO alignment and final report
- Limits: No scenario modifications, only verification and final reporting
- Dependencies: All previous validation steps must be complete

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Load SEO Keyword Map

Load the SEO keyword map from `{output_folder}/A-Product-Brief/` (content language section or dedicated SEO strategy file).

If no SEO keyword map exists, note this as a gap and skip to the final report (instruction 5).

### 2. Page-Keyword Mapping

For each unique page across all scenarios:

- [ ] Page has at least one primary keyword assigned (from Phase 1 keyword map)
- [ ] Keywords match the page user intent (not forced)
- [ ] No two pages compete for the same primary keyword

### 3. Keyword Coverage

- [ ] All high-priority keywords from Phase 1 map to at least one scenario page
- [ ] Service keywords map to relevant service pages
- [ ] Location keywords map to location-relevant pages
- [ ] Problem keywords map to solution pages

### 4. URL Slug Alignment

If URL slugs were defined in the keyword map:

- [ ] Scenario page names align with planned URL slugs
- [ ] No naming conflicts between scenario names and SEO slugs

### 5. SEO Report

```
## SEO Keyword Alignment Report

**Pages with keywords:** [X]/[Total]
**Keyword conflicts:** [N]
**Unmapped keywords:** [list]

| Page | Primary Keyword | Secondary | Status |
|------|----------------|-----------|--------|
| [Name] | [keyword] | [keywords] | ✅/⚠️/❌ |

**Overall SEO readiness:** [Good / Needs Work / No keyword map]
```

### 6. Final Validation Report

Compile results from all 5 validation steps into a summary:

```
## Phase 3 Validation Report

**Project:** {project_name}
**Date:** [date]
**Scenarios validated:** [N]

### Results Summary
| Check | Status | Issues |
|-------|--------|--------|
| Scenario Coverage | ✅/⚠️/❌ | [summary] |
| Navigation Patterns | ✅/⚠️/❌ | [summary] |
| Outline Completeness | ✅/⚠️/❌ | [summary] |
| Cross-Scenario Consistency | ✅/⚠️/❌ | [summary] |
| SEO Keyword Alignment | ✅/⚠️/❌ | [summary] |

### Critical Issues (must fix)
[list or "None"]

### Warnings (should fix)
[list or "None"]

### Recommendations
[list or "All clear"]
```

Save report to `{output_folder}/C-UX-Scenarios/validation-report.md`

### 7. Present MENU OPTIONS

Display: "[M] Main Menu — Return to workflow start"

#### Menu Handling Logic:

- IF M: Load, read entire file, then execute {workflowFile}

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY complete workflow when user selects 'M' or indicates they want to stop
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [M main menu option] is selected and [final validation report compiled and saved], will the validation workflow end gracefully with all results documented.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- SEO keyword map loaded (or gap noted if absent)
- Page-keyword mapping verified for all pages
- Keyword coverage checked against Phase 1 map
- SEO report generated
- Final validation report compiled from all 5 steps
- Report saved to output folder
- Menu presented and user input handled correctly

### ❌ SYSTEM FAILURE:

- Not checking for SEO keyword map
- Skipping the final validation report compilation
- Not saving the report to output folder
- Missing results from any of the 5 validation steps
- Modifying scenario files during validation

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
