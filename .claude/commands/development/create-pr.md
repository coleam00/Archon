# Create Pull Request

Create a well-structured pull request with proper description and context.

## PR Title (if provided)
$ARGUMENTS

## Process

1. **Prepare Branch**
   ```bash
   # Check current branch
   git branch --show-current
   
   # Ensure we're not on main
   # If on main, create a feature branch
   ```

2. **Review Changes**
   ```bash
   # See what will be included
   git status
   git diff main...HEAD
   ```

3. **Create Commits**
   - Stage relevant files
   - Create logical, atomic commits if not already done
   - Write clear commit messages following conventional commits, do not include any reference to cluade, written by clade etc:
     - `feat:` for new features
     - `fix:` for bug fixes
     - `docs:` for documentation
     - `test:` for tests
     - `refactor:` for refactoring

4. **Push to Remote**
   ```bash
   git push -u origin HEAD
   ```

5. **Create PR**
   ```bash
   gh pr create --title "$ARGUMENTS" --body "$(cat <<'EOF'
   ## Summary
   [Brief description of what this PR does]
   
   ## Changes
   - [List key changes]
   - [Be specific]
   
   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update
   
   ## Testing
   - [ ] Tests pass locally
   - [ ] Added new tests
   - [ ] Manual testing completed
   
   ## Checklist
   - [ ] Code follows project style
   - [ ] Self-reviewed
   - [ ] Updated documentation
   - [ ] No console.logs or debug code
   
   ## Screenshots (if applicable)
   [Add screenshots for UI changes]
   
   ## Additional Context
   [Any extra information reviewers should know]
   EOF
   )"
   ```

6. **Post-Creation**
   - Add labels if needed: `gh pr edit --add-label "feature,needs-review"`
   - Request reviewers if known
   - Link to related issues

Remember to:
- Keep PRs focused and small
- Provide context for reviewers
- Test thoroughly before creating PR