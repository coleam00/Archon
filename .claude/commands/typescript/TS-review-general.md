# General TypeScript/Astro Codebase Review

Perform a comprehensive review of the entire TypeScript/Astro codebase focusing on architecture, patterns, and best practices.

Review scope: $ARGUMENTS

If no specific scope provided, review the entire codebase.

## Review Process

1. **Codebase Analysis**
   - Analyze overall project structure and architecture
   - Review component organization and modularity
   - Check for consistency across the codebase
   - Identify technical debt and improvement opportunities

2. **Pattern Consistency**
   - Ensure consistent use of Astro patterns
   - Validate TypeScript usage across files
   - Check for consistent naming conventions
   - Review import/export patterns

3. **Performance Assessment**
   - Evaluate bundle size and optimization
   - Review hydration strategy implementation
   - Check for unnecessary client-side JavaScript
   - Assess image optimization usage

## Review Focus Areas

### 1. **Architecture & Structure**
   - Islands Architecture implementation
   - Component organization (static vs interactive)
   - Content collections structure
   - API routes organization
   - Proper separation of concerns

### 2. **TypeScript Quality**
   - Strict mode compliance across all files
   - Type safety and explicit typing
   - Interface definitions and exports
   - Proper use of Astro's built-in types
   - Generic usage and constraints

### 3. **Astro-Specific Patterns**
   - Hydration directives usage patterns
   - Static-first approach implementation
   - Server islands configuration
   - Content management patterns
   - Framework integration consistency

### 4. **Performance & Optimization**
   - Bundle analysis and optimization
   - Image optimization implementation
   - Code splitting and lazy loading
   - Unnecessary JavaScript elimination
   - Hydration strategy effectiveness

### 5. **Security & Validation**
   - Environment variable management
   - Content Security Policy implementation
   - Input validation patterns
   - API security measures
   - Zod schema consistency

### 6. **Code Quality Standards**
   - Component size limits (200 lines Astro, 500 lines max)
   - Function complexity and length
   - Code duplication assessment
   - Error handling patterns
   - Logging and debugging practices

### 7. **Testing Coverage**
   - Vitest configuration and usage
   - Component test coverage
   - API route testing
   - Integration test quality
   - Mock usage patterns

### 8. **Dependencies & Tooling**
   - pnpm usage compliance
   - Dependency management
   - Build configuration
   - Development tooling setup
   - Integration configurations

### 9. **Documentation & Maintenance**
   - Code documentation quality
   - README completeness
   - Component prop documentation
   - API documentation
   - CLAUDE.md updates

### 10. **Standards Compliance**
   - ESLint configuration and compliance
   - Prettier formatting consistency
   - TypeScript strict mode adherence
   - Build process compliance
   - Pre-commit hook effectiveness

## Analysis Commands

Execute these commands to gather comprehensive data:

```bash
# Project structure analysis
tree -I 'node_modules|dist|.git' -L 3

# TypeScript analysis
npx tsc --noEmit --listFiles

# Bundle analysis
pnpm run build && du -sh dist/

# Code quality metrics
rg --stats "client:" --type astro
rg --stats "export interface" --type ts
rg --stats "import type" --type ts

# Test coverage
pnpm run test:coverage

# Dependency analysis
pnpm list --depth=0
pnpm audit
```

## Review Output

Create a comprehensive review report:

```markdown
# TypeScript/Astro Codebase Review #[number]

## Executive Summary
[High-level overview of codebase health, architecture quality, and key findings]

## Architecture Assessment

### 🏗️ Structure Quality: [Grade A-F]
- [Overall architecture assessment]
- [Component organization evaluation]
- [Islands Architecture implementation]

### 📊 Metrics
- Total Components: X (.astro: Y, Framework: Z)
- Bundle Size: X MB (JS: Y MB, CSS: Z MB)
- Test Coverage: X% (Target: 80%)
- TypeScript Compliance: X% strict mode

## Critical Findings

### 🔴 Architecture Issues (Must Fix)
- [Structural problems requiring immediate attention]
- [Performance bottlenecks]
- [Security vulnerabilities]

### 🟡 Pattern Inconsistencies (Should Fix)
- [Inconsistent implementations]
- [Suboptimal patterns]
- [Technical debt items]

### 🟢 Optimization Opportunities (Consider)
- [Performance improvements]
- [Code quality enhancements]
- [Maintainability improvements]

## Quality Assessment

### TypeScript Quality: [Grade A-F]
- Type safety compliance
- Interface definitions
- Strict mode adherence
- Generic usage patterns

### Astro Patterns: [Grade A-F]
- Hydration strategy implementation
- Static-first approach
- Content management
- Framework integration

### Performance Score: [Grade A-F]
- Bundle optimization
- Image optimization
- Hydration efficiency
- Loading performance

## Detailed Analysis

### Component Analysis
- [Component size distribution]
- [Hydration patterns used]
- [Framework usage breakdown]
- [Reusability assessment]

### Security Review
- [Environment variable usage]
- [Input validation patterns]
- [API security measures]
- [Content Security Policy]

### Testing Quality
- [Coverage distribution]
- [Test quality assessment]
- [Missing test areas]
- [Mock usage patterns]

## Recommendations

### Immediate Actions (Next Sprint)
1. [Priority fixes with specific file references]
2. [Critical performance improvements]
3. [Security enhancements]

### Medium-term Improvements (Next Month)
1. [Architecture improvements]
2. [Code quality enhancements]
3. [Testing improvements]

### Long-term Strategy (Next Quarter)
1. [Architectural evolution]
2. [Performance optimization strategy]
3. [Maintenance improvements]

## Best Practices Observed
- [Highlight excellent implementations]
- [Patterns worth replicating]
- [Quality code examples]

## Compliance Checklist
- [ ] `astro check` passes project-wide
- [ ] `pnpm run lint` zero warnings
- [ ] `pnpm run build` succeeds
- [ ] `pnpm test` 80%+ coverage
- [ ] All components under size limits
- [ ] No `any` types in codebase
- [ ] Proper hydration directives
- [ ] Environment variables typed
- [ ] Content collections with schemas
- [ ] Security headers implemented

## Metrics Dashboard
```
Code Quality Score: X/100
├── TypeScript Quality: X/25
├── Astro Patterns: X/25
├── Performance: X/25
└── Testing: X/25

Technical Debt: X hours estimated
Bundle Size: X MB (Target: <2MB)
Build Time: X seconds
Test Coverage: X% (Target: 80%)
```

## Next Review
Recommended review frequency: [Monthly/Quarterly]
Focus areas for next review: [Specific areas to monitor]
```

Save report to PRPs/code_reviews/general_review_[YYYY-MM-DD].md