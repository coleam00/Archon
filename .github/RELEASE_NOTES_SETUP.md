# AI-Generated Release Notes Setup

This repository uses Claude AI to automatically generate comprehensive release notes when you create a new release.

## How It Works

The workflow triggers when:
- You push a new tag (e.g., `v1.0.0`)
- You create a GitHub release
- You manually trigger it via workflow dispatch

Claude AI analyzes:
- Commit messages since the last release
- Merged pull requests
- File changes by component (frontend, backend, docs)
- Contributors

Then generates structured release notes with:
- Overview and key changes
- Feature additions, improvements, and bug fixes
- Technical changes by component
- Statistics and contributor acknowledgments
- Breaking changes (important for beta!)

## Testing Locally First (Recommended!)

Before setting up the GitHub Action, you can test the release notes generation locally:

### Prerequisites

```bash
# Install required tools (if not already installed)
sudo apt install jq curl  # Linux
# or
brew install jq curl      # macOS

# Install GitHub CLI (optional, for PR detection)
# See: https://github.com/cli/cli#installation
```

### Run Local Test

```bash
# 1. Export your Anthropic API key
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# 2. Run the test script

# Compare origin/stable vs main branches (default - shows unreleased changes)
./.github/test-release-notes.sh

# Or specify branches explicitly (automatically handles remote branches)
./.github/test-release-notes.sh stable main        # Will use origin/stable if no local stable
./.github/test-release-notes.sh origin/stable main # Explicit remote branch

# Or use range syntax
./.github/test-release-notes.sh stable..main

# Or compare tags for a release
./.github/test-release-notes.sh v1.0.0 v2.0.0

# Or test a single tag (compares with previous tag)
./.github/test-release-notes.sh v0.1.0
```

### What the Local Test Does

1. **Gathers git data**: Commits, file changes, and PRs (if gh CLI available)
2. **Calls Claude API**: Generates release notes using the same prompt as the workflow
3. **Saves output**: Creates `release-notes-<tag>.md` in current directory
4. **Shows preview**: Displays the generated notes in your terminal

### Example Output

```bash
$ ./.github/test-release-notes.sh v0.2.0

🤖 Local Release Notes Generator Test
==========================================

Current tag: v0.2.0
Previous tag: v0.1.0

📝 Gathering commits...
Found 42 commits

📊 Analyzing file changes...
Files summary: 28 files changed, 1547 insertions(+), 423 deletions(-)

🔀 Looking for merged PRs...
Found 8 merged PRs

🤖 Generating release notes with Claude...
✅ Release notes generated successfully!

📄 Output saved to: release-notes-v0.2.0.md

==========================================
Preview:
==========================================
[Generated release notes appear here]
==========================================
✅ Done!
```

### Testing Different Scenarios

```bash
# 🔥 MOST COMMON: See what's new in main vs stable (unreleased changes)
./.github/test-release-notes.sh
# Output: release-notes-origin-stable..main.md

# Or with explicit arguments
./.github/test-release-notes.sh stable main
# Output: release-notes-origin-stable..main.md (auto-resolves to origin/stable)

# Test your first release (compares with initial commit)
./.github/test-release-notes.sh v0.1.0

# Test a release between two specific tags
./.github/test-release-notes.sh v1.0.0 v2.0.0

# Test what would be in next release (current branch vs stable)
git checkout main
./.github/test-release-notes.sh stable main
```

### Typical Workflow: Stable vs Main

For projects with separate `stable` (production) and `main` (development) branches:

```bash
# 1. See what's ready to release (compare branches)
export ANTHROPIC_API_KEY="sk-ant-..."
./.github/test-release-notes.sh stable main
# Or explicitly use remote branch: ./.github/test-release-notes.sh origin/stable main

# 2. Review the generated notes
cat release-notes-origin-stable..main.md

# 3. When ready to release, fetch latest and merge main to stable
git fetch origin
git checkout -b stable origin/stable  # Create local tracking branch if needed
git merge main
git push origin stable

# 4. Create a release tag
git tag v1.0.0
git push origin v1.0.0

# 5. The GitHub Action will automatically generate release notes
# (You can also manually create the release with the generated notes)
gh release create v1.0.0 --title "Release v1.0.0" --notes-file release-notes-origin-stable..main.md
```

## Setup Instructions

### 1. Get Claude Code OAuth Token

The GitHub Action uses Claude Code OAuth token (same as the `claude-review` workflow):

1. Go to [Claude Code OAuth Setup](https://docs.anthropic.com/claude-code/oauth)
2. Follow the instructions to get your OAuth token
3. Copy the token

### 2. Add GitHub Secret

1. Go to your repository's Settings
2. Navigate to **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `CLAUDE_CODE_OAUTH_TOKEN`
5. Value: Paste your Claude Code OAuth token
6. Click **Add secret**

> **Note:** If you already have `CLAUDE_CODE_OAUTH_TOKEN` set up for `claude-review` workflow, you're all set! The same token is used for both workflows.

### 3. (Optional) Get Anthropic API Key for Local Testing

For local testing, you'll need an API key:

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Create a new API key
3. Copy the key (starts with `sk-ant-...`)
4. Export it: `export ANTHROPIC_API_KEY="sk-ant-..."`

> **Note:** The GitHub Action uses OAuth token, but local testing uses API key for simplicity.

### 4. Test the Workflow

#### Option A: Create a Release via GitHub UI

1. Go to **Releases** in your repository
2. Click **Draft a new release**
3. Choose or create a tag (e.g., `v0.1.0`)
4. Click **Publish release**
5. The workflow will automatically run and update the release notes

#### Option B: Push a Tag via Git

```bash
# Create and push a new tag
git tag v0.1.0
git push origin v0.1.0

# The workflow will automatically create a release with AI-generated notes
```

#### Option C: Manual Trigger

1. Go to **Actions** tab
2. Select "AI-Generated Release Notes" workflow
3. Click **Run workflow**
4. Enter the tag name (e.g., `v0.1.0`)
5. Click **Run workflow**

## Usage Examples

### Creating Your First Release

```bash
# Tag your current state
git tag v0.1.0-beta

# Push the tag
git push origin v0.1.0-beta

# Check Actions tab - release notes will be generated automatically
```

### Creating Subsequent Releases

```bash
# Make your changes and commits
git add .
git commit -m "feat: Add AI-powered search feature"
git push

# When ready to release
git tag v0.2.0-beta
git push origin v0.2.0-beta

# Release notes will compare v0.2.0-beta with v0.1.0-beta
```

## What Gets Generated

The AI generates release notes in this structure:

```markdown
# 🚀 Release v0.2.0

## 📝 Overview
[Summary of the release]

## ✨ What's New

### Major Features
- [New features]

### Improvements
- [Enhancements]

### Bug Fixes
- [Fixes]

## 🔧 Technical Changes

### Backend (Python/FastAPI)
- [Backend changes]

### Frontend (React/TypeScript)
- [Frontend changes]

### Infrastructure
- [Infrastructure updates]

## 📊 Statistics
- Commits: X
- Pull Requests: Y
- Files Changed: Z
- Contributors: N

## 🙏 Contributors
[List of contributors]

## ⚠️ Breaking Changes
[Any breaking changes]

## 🔗 Links
- Full Changelog: [link]
```

## Customization

### Modify the Prompt

Edit `.github/workflows/release-notes.yml` and change the prompt in the "Generate release notes with Claude" step to adjust:
- Tone and style
- Structure
- Focus areas
- Level of detail

### Change Claude Model

In the workflow file, you can change the model:

```yaml
"model": "claude-sonnet-4-20250514"  # Latest Sonnet
# or
"model": "claude-3-7-sonnet-20250219"  # Sonnet 3.7
# or
"model": "claude-opus-4-20250514"  # Opus 4 (more detailed)
```

### Adjust Token Limit

Increase `max_tokens` for longer release notes:

```yaml
"max_tokens": 4096  # Default
# or
"max_tokens": 8192  # For more detailed notes
```

## Troubleshooting

### Workflow Fails with "ANTHROPIC_API_KEY not found"

- Ensure you've added the secret in repository settings
- Secret name must be exactly `ANTHROPIC_API_KEY`
- Secret must be a valid Anthropic API key

### Empty or Incomplete Release Notes

- Check if commits exist between tags
- Verify git history is complete (workflow uses `fetch-depth: 0`)
- Check Actions logs for API errors

### API Rate Limits

- Anthropic has generous rate limits for API keys
- For very frequent releases, consider caching or batching

## Authentication: GitHub Action vs Local Testing

### GitHub Action (Claude Code OAuth)
- Uses `CLAUDE_CODE_OAUTH_TOKEN` secret
- Same authentication as `claude-review` workflow
- Integrated with GitHub through Claude Code Action
- No direct API costs (usage included with Claude Code)

### Local Testing (API Key)
- Uses `ANTHROPIC_API_KEY` environment variable
- Direct API calls to Claude
- Simpler for local testing and debugging
- Cost: ~$0.003 per release (less than a penny)

### Why Two Methods?

- **GitHub Action**: Uses Claude Code Action for better GitHub integration and consistency with other workflows
- **Local Testing**: Uses direct API for simplicity and faster iteration during development

## Cost Estimation

### Local Testing (API Key)
Claude API pricing (as of 2025):
- Sonnet 4: ~$0.003 per release (assuming ~4K tokens)
- Each release generation costs less than a penny
- For a project with monthly releases: ~$0.036/year

### GitHub Action (OAuth Token)
- No additional costs beyond your Claude Code subscription
- Usage included in Claude Code plan

## Best Practices

### Write Good Commit Messages

The AI works better with clear commits:

```bash
# ✅ Good
git commit -m "feat: Add vector search with pgvector"
git commit -m "fix: Resolve race condition in crawling service"
git commit -m "docs: Update API documentation"

# ❌ Less helpful
git commit -m "updates"
git commit -m "fix stuff"
git commit -m "wip"
```

### Use Conventional Commits

The workflow benefits from conventional commit format:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation
- `refactor:` - Code refactoring
- `test:` - Tests
- `chore:` - Maintenance

### Tag Semantically

Use semantic versioning:
- `v1.0.0` - Major release
- `v1.1.0` - Minor release (new features)
- `v1.1.1` - Patch release (bug fixes)
- `v0.1.0-beta` - Beta releases

## Manual Editing

You can always edit the generated release notes:

1. Go to the release page
2. Click **Edit release**
3. Modify the notes as needed
4. Click **Update release**

## Workflow Outputs

The workflow provides:
- Updated GitHub release with AI-generated notes
- Artifact with release notes (kept for 90 days)
- Comments on related PRs linking to the release
- Summary in Actions tab

## Advanced: Using with Pre-releases

```bash
# Create a pre-release
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1

# Mark as pre-release in GitHub UI or via gh CLI
gh release create v0.2.0-rc.1 --prerelease
```

## Integration with Other Tools

### Notify Slack/Discord

Add a notification step after release creation:

```yaml
- name: Notify team
  run: |
    curl -X POST YOUR_WEBHOOK_URL \
      -H 'Content-Type: application/json' \
      -d '{"text":"Release ${{ steps.get_tag.outputs.tag }} published!"}'
```

### Update Changelog File

Append to CHANGELOG.md:

```yaml
- name: Update changelog
  run: |
    cat release_notes.md >> CHANGELOG.md
    git add CHANGELOG.md
    git commit -m "docs: Update changelog for ${{ steps.get_tag.outputs.tag }}"
    git push
```

## Support

If you encounter issues:
1. Check the workflow logs in Actions tab
2. Verify your API key is valid
3. Ensure git history is available
4. Open an issue with workflow logs attached
