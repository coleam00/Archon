---
description: Analyze UI components for reusability, Radix usage, primitives, and styling consistency
argument-hint: <feature path, component path, or directory>
allowed-tools: Read, Grep, Glob, Write, Bash
thinking: auto
---

# UI Consistency Review for Archon

**Review scope**: $ARGUMENTS

## Process

### Step 1: Load Standards
Read `PRPs/ai_docs/UI_STANDARDS.md` - This is the single source of truth for all rules, patterns, and scans.

### Step 2: Find Files
Glob all `.tsx` files in the provided path.

### Step 3: Run Automated Scans
Execute ALL scans from **UI_STANDARDS.md - AUTOMATED SCAN REFERENCE** section:
- Critical scans (dynamic classes, non-responsive grids, native HTML, unconstrained scroll)
- High priority scans (keyboard support, dark mode, hardcoded patterns, min-w-0)
- Medium priority scans (TypeScript, color mismatches, props validation)

### Step 4: Deep Analysis
For each file, check against ALL rules from **UI_STANDARDS.md sections 1-8**:
1. TAILWIND V4 - Static classes, tokens
2. LAYOUT & RESPONSIVE - Grids, scroll, truncation
3. THEMING - Dark mode variants
4. RADIX UI - Primitives usage
5. PRIMITIVES LIBRARY - Card, PillNavigation, styles.ts
6. ACCESSIBILITY - Keyboard, ARIA, focus
7. TYPESCRIPT & API CONTRACTS - Types, props, consistency
8. FUNCTIONAL LOGIC - UI actually works

**For primitives** (files in `/features/ui/primitives/`):
- Verify all props affect rendering
- Check color variant objects have: checked, glow, focusRing, hover
- Validate prop implementations match interface

### Step 5: Generate Report
Save to `PRPs/reviews/ui-consistency-review-[feature].md` with:
- Overall scores (use **UI_STANDARDS.md - SCORING VIOLATIONS**)
- Component-by-component analysis
- Violations with file:line, current code, required fix
- Prioritized action items

### Step 6: Create PRP
Use `/prp-claude-code:prp-claude-code-create ui-consistency-fixes-[feature]` if violations found.

**PRP should reference:**
- The review report
- Specific UI_STANDARDS.md sections violated
- Automated scan commands to re-run for validation

---

**Note**: Do NOT duplicate rules/patterns from UI_STANDARDS.md. Just reference section numbers.
