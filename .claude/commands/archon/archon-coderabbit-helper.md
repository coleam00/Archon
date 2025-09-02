---
name: Archon CodeRabbit Helper
description: Analyze CodeRabbit suggestions, assess validity, and provide actionable options with tradeoffs
argument-hint: Paste the CodeRabbit suggestion here
---

# CodeRabbit Review Analysis

**Review:** $ARGUMENTS

## Instructions

Analyze this CodeRabbit suggestion following these steps:

### 1. Deep Analysis

- Understand the technical issue being raised
- Check if it's a real problem or false positive
- Search the codebase for related patterns and context
- Consider project phase (early beta) and architecture

### 2. Context Assessment

- We're in early beta - prioritize simplicity over perfection
- Follow KISS principles and existing codebase patterns
- Avoid premature optimization or over-engineering
- Consider if this affects user experience or is internal only

### 3. Generate Options

Think harder about the problem and potential solutions.
Provide 2-5 practical options with clear tradeoffs

## Response Format

### 📋 Issue Summary

_[One sentence describing what CodeRabbit found]_

### ✅ Is this valid?

_[YES/NO with brief explanation]_

### 🎯 Priority for this PR

_[HIGH/MEDIUM/LOW/SKIP with reasoning]_

### 🔧 Options & Tradeoffs

**Option 1: [Name]**

- What: _[Brief description]_
- Pros: _[Benefits]_
- Cons: _[Drawbacks]_
- Effort: _[Low/Medium/High]_

**Option 2: [Name]**

- What: _[Brief description]_
- Pros: _[Benefits]_
- Cons: _[Drawbacks]_
- Effort: _[Low/Medium/High]_

### 💡 Recommendation

_[Your recommended option with 1-2 sentence justification]_

## User feedback

- When you have presented the review to the user you must ask for their feedback on the suggested changes.
- Ask the user if they wish to discuss any of the options further
- If the user wishes for you to explore further, provide additional options or tradeoffs.
- If the user is ready to implement the recommended option right away
