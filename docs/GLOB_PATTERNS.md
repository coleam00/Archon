# Glob Pattern Filtering Guide

## Overview

Archon's knowledge crawling system supports flexible URL filtering using glob patterns with `.gitignore`-style syntax. Use a single unified field to specify which URLs to include or exclude during crawls.

## Syntax

### Basic Format
```text
pattern1, pattern2, !exclude1, !exclude2
```

### Rules
1. **Include patterns** - Regular glob patterns match URLs to include
2. **Exclude patterns** - Patterns prefixed with `!` exclude URLs
3. **Comma-separated** - Separate multiple patterns with commas
4. **Exclude takes precedence** - If a URL matches any exclude pattern, it's rejected even if it matches an include pattern

### Logic Flow
```text
1. If no patterns specified → Include all URLs
2. If URL matches ANY exclude pattern (!) → Reject
3. If include patterns exist AND URL matches at least one → Accept
4. Otherwise → Reject
```

## Pattern Syntax

### Wildcards
- `*` - Matches any characters (including `/` in paths)
- `**` - Same as `*` in fnmatch (matches any characters)
- `?` - Matches any single character

### Examples
```bash
# Match specific directory
**/docs/**           # Matches: /docs/, /en/docs/, /api/v1/docs/

# Match file extensions
**/*.md              # Matches: /readme.md, /docs/guide.md

# Exact path prefix
/api/v1/*            # Matches: /api/v1/users, /api/v1/posts

# Combined patterns
**/en/**, **/docs/** # Matches: /en/guide, /docs/api
```

## Common Use Cases

### 1. Documentation Sites - Language Filtering

**Scenario**: Only crawl English documentation

```text
**/en/**, !**/api/**, !**/changelog/**
```

**Matches**:
- ✅ `/en/getting-started`
- ✅ `/docs/en/tutorial`
- ✅ `/en/guides/setup`

**Excludes**:
- ❌ `/fr/getting-started` (not English)
- ❌ `/en/api/reference` (API excluded)
- ❌ `/en/changelog` (changelog excluded)

### 2. GitHub Repositories

**Scenario**: Crawl repository code files only (directories and files)

```text
**/tree/**, **/blob/**
```

**Auto-configured when entering GitHub URLs like**:
```text
https://github.com/username/reponame
```

**What it matches:**
- ✅ `/username/reponame/tree/main/src` (directory view)
- ✅ `/username/reponame/blob/main/README.md` (file view)
- ✅ `/username/reponame/tree/main/src/components` (nested directory)

**What it excludes:**
- ❌ `/username/reponame/issues` (issues page)
- ❌ `/username/reponame/pull/123` (pull request)
- ❌ `/username/reponame/actions` (GitHub Actions)
- ❌ `/username/reponame/security` (security tab)
- ❌ `/username/reponame/wiki` (wiki pages)
- ❌ Any other GitHub UI pages

**Why this pattern?**
Using include patterns is cleaner and more comprehensive than excluding individual sections. It automatically excludes any future GitHub features without updating the pattern.

### 3. Blog Sites

**Scenario**: Only blog posts, exclude drafts and archives

```text
**/blog/**, !**/draft/**, !**/archive/**
```

**Matches**:
- ✅ `/blog/2024/my-post`
- ✅ `/en/blog/tutorial`

**Excludes**:
- ❌ `/blog/draft/unpublished`
- ❌ `/blog/archive/2020`

### 4. Exclude Only (No Includes)

**Scenario**: Crawl everything except certain languages

```text
!**/fr/**, !**/de/**, !**/ja/**
```

**Result**: All URLs crawled EXCEPT French, German, and Japanese pages

## GitHub Auto-Configuration

When you enter a GitHub repository URL, Archon automatically configures optimal settings:

### Trigger
Any URL matching:
```text
https://github.com/username/reponame
http://github.com/username/reponame
github.com/username/reponame
```

### Auto-Applied Settings
1. **Pattern**: `**/tree/**, **/blob/**` (code files only)
2. **Depth**: 3 (for nested directories)
3. **Tag**: "GitHub Repo"

### Why These Patterns?
- `**/tree/**` matches directory views (browsing folders)
- `**/blob/**` matches file views (individual files)
- Automatically excludes issues, PRs, actions, wiki, and all non-code pages
- More efficient than listing exclusions
- Works with any future GitHub features without updates

## Link Collections (llms.txt, sitemap.xml)

### Behavior
For link collections, patterns filter the discovered links:

1. **Parse collection** → Extract all URLs
2. **Apply patterns** → Filter URLs by include/exclude rules
3. **Review modal** → Preview filtered links before crawling
4. **Crawl selected** → Only crawl matching URLs

### Example Workflow

**Sitemap URL**: `https://docs.example.com/sitemap.xml`

**Sitemap contains**:
```text
https://docs.example.com/en/intro
https://docs.example.com/en/api
https://docs.example.com/fr/intro
https://docs.example.com/changelog
```

**Pattern**: `**/en/**, !**/api/**`

**Filtered Results**:
- ✅ `/en/intro` (matches include, not excluded)
- ❌ `/en/api` (matches include BUT excluded)
- ❌ `/fr/intro` (doesn't match include)
- ❌ `/changelog` (doesn't match include)

## Pattern Testing Tips

### Start Simple
1. Begin with broad include pattern
2. Test the crawl preview (for link collections)
3. Add exclusions to refine

### Use Specific Patterns
```bash
# ❌ Too broad
**/*

# ✅ Specific and meaningful
**/en/**, **/docs/**
```

### Test Pattern Matching

Use the pattern preview in the Link Review Modal to see which URLs match before crawling.

### Common Mistakes

❌ **Forgetting the `!` prefix**
```text
**/en/**, **/api/**  # This includes BOTH en and api
```

✅ **Correct exclusion syntax**
```text
**/en/**, !**/api/**  # This includes en but excludes api
```

❌ **Assuming `*` matches only one path segment**
```text
/docs/*/intro  # This WILL match /docs/en/v1/intro (not just /docs/en/intro)
```

✅ **Understanding fnmatch behavior**
```text
# In fnmatch (used by Archon), * matches any characters including /
# Both * and ** behave the same way
```

## API Integration

When the frontend sends patterns to the backend, they're automatically parsed:

```typescript
// Frontend: Unified field
urlPatterns: "**/en/**, !**/api/**"

// Parsed and sent to backend
{
  url_include_patterns: ["**/en/**"],
  url_exclude_patterns: ["**/api/**"]
}
```

## Testing Patterns

See [TESTING.md](../TESTING.md#glob-pattern-testing) for comprehensive testing examples.

## Further Reading

- [fnmatch documentation](https://docs.python.org/3/library/fnmatch.html) - Python's glob pattern matching
- [.gitignore patterns](https://git-scm.com/docs/gitignore#_pattern_format) - Similar syntax inspiration
- [PR #847](https://github.com/coleam00/archon/pull/847) - Original implementation

## Support

If you encounter issues with pattern matching:
1. Check the pattern syntax for typos
2. Test with the Link Review Modal (for link collections)
3. Start with simpler patterns and add complexity
4. Remember: `!` prefix is required for exclusions
