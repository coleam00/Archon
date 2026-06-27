---
name: 'step-02-explore-and-capture'
description: 'Systematically explore the target and capture a complete inventory of pages, components, patterns, and design tokens'

# File References
nextStepFile: './step-03-generate-specs.md'
---

# Step 2: Explore and Capture

## STEP GOAL:

Systematically explore the target and capture a complete inventory of pages, components, patterns, and design tokens.

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

- 🎯 Focus only on crawling pages, capturing structure, noting interactions, and extracting design tokens
- 🚫 FORBIDDEN to begin generating specs — that is the next step
- 💬 Approach: Systematically explore using the access method, documenting everything as inventories
- 📋 Use the appropriate exploration method (URL, source code, or screenshots) as determined in Step 1

## EXECUTION PROTOCOLS:

- 🎯 Complete inventories of pages, navigation, components, colors, typography, and spacing
- 💾 Document all inventories in the dialog file
- 📖 Reference the access method and extraction goals from Step 1
- 🚫 Do not generate specs during exploration

## CONTEXT BOUNDARIES:

- Available context: Target definition and access method from Step 1
- Focus: Exploration and capturing — inventorying everything found
- Limits: No spec generation, no design system document creation
- Dependencies: Step 1 must be complete (target defined, access verified)

## Sequence of Instructions (Do not deviate, skip, or optimize)

### If URL (Browser Access)

#### 1a. Crawl Pages

1. Start at the home page or main entry point
2. Follow navigation links to discover all pages
3. For each page, note: URL, page title, primary purpose, key content sections, interactive elements
4. Check for hidden pages: sitemap.xml, footer links, search results

#### 1b. Capture Structure

For each page: Header, Main content, Footer, Sidebar (if present)

#### 1c. Note Interactions

Hover states, dropdown behavior, form validation, modal triggers, loading states, responsive breakpoints

#### 1d. Extract CSS and Design Tokens

From browser DevTools or computed styles: colors, fonts, spacing, border radius, shadows, breakpoints

### If Source Code Access

#### 1e. Read Code Structure

Identify component directory, list and categorize components, map routes, identify shared styles and theme config

#### 1f. Map Routes

Create a route inventory mapping URLs to pages/views

### If Screenshots

#### 1g. Analyze Visual Patterns

For each screenshot: identify page type, sketch layout grid, list components, note typography hierarchy, extract colors, note spacing rhythm

### Document Results (All Methods)

Compile findings into these inventories:

#### Page Inventory

| #   | Page  | URL / Route | Type    | Key Sections                      |
| --- | ----- | ----------- | ------- | --------------------------------- |
| 1   | Home  | /           | Landing | Hero, Features, Testimonials, CTA |
| 2   | About | /about      | Content | Story, Team, Values               |

#### Navigation Structure

Primary nav, secondary nav, footer nav, mobile nav

#### Component Inventory

| Component | Variants | Used On |
| --------- | -------- | ------- |

#### Color Palette

| Name | Value | Usage |
| ---- | ----- | ----- |

#### Typography Scale

| Level | Size | Weight | Line Height | Usage |
| ----- | ---- | ------ | ----------- | ----- |

#### Spacing Patterns

Note the base spacing unit and common values.

### Verify Checklist

- [ ] All pages discovered and inventoried
- [ ] Navigation structure documented
- [ ] Component inventory created
- [ ] Color palette extracted
- [ ] Typography scale documented
- [ ] Spacing patterns noted
- [ ] Interactive patterns observed (hover, modal, form behavior)

### Present MENU OPTIONS

Display: "**Select an Option:** [C] Continue to Step 3: Generate Specs"

#### Menu Handling Logic:

- IF C: Update design log, then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then redisplay menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN all inventories are captured and documented will you then load and read fully `{nextStepFile}` to execute.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All pages discovered and inventoried
- Navigation structure documented
- Component inventory created
- Color palette extracted
- Typography scale documented
- Spacing patterns noted
- Interactive patterns observed

### ❌ SYSTEM FAILURE:

- Beginning spec generation before exploration is complete
- Missing pages or components in inventory
- Not extracting design tokens
- Skipping interaction observation

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
