Perform an intelligent merge conflict resolution with deep understanding of our codebase.

## Pre-resolution analysis:

1. Understand what each branch was trying to achieve:
git log --oneline origin/main..HEAD
git log --oneline HEAD..origin/main

2. Check if there are any related issues or PRs:
git log --grep="fix" --grep="feat" --oneline -20
- use the github cli as needed

3. Identify the type of conflicts (feature vs feature, fix vs refactor, etc.)

4. Think hard about your findings and plan accordingly

## Resolution strategy:

### For different file types:

**Source code conflicts (.js, .ts, .py, etc.)**:
- Understand the business logic of both changes
- Merge both features if they're complementary
- If conflicting, check which has better test coverage
- Look for related files that might need updates

**Test file conflicts**:
- Usually merge both sets of tests
- Ensure no duplicate test names
- Update test descriptions if needed

**Configuration files**:
- package.json: Merge dependencies, scripts
- .env.example: Include all new variables
- CI/CD configs: Merge all jobs unless duplicate

**Documentation conflicts**:
- Merge both documentation updates
- Ensure consistency in terminology
- Update table of contents if needed

**Lock files (package-lock.json, poetry.lock)**:
- Delete and regenerate after resolving package.json/pyproject.toml

## Post-resolution verification:

1. Run linters to check code style
2. Run type checkers if applicable  
3. Run test suite
4. Check for semantic conflicts (code that merges but breaks functionality)
5. Verify no debugging code was left in

## Final steps:

1. Create a detailed summary of all resolutions
2. If any resolutions are uncertain, mark them with TODO comments
3. Suggest additional testing that might be needed
4. Stage all resolved files

Begin by analyzing the current conflict situation with git status and understanding both branches.