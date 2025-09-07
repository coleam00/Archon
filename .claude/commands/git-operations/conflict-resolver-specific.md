You are an expert at resolving Git merge conflicts. $ARGUMENTS

## Resolution strategy based on arguments:

- If "safe" is mentioned: Only auto-resolve obvious conflicts, ask for guidance on complex ones
- If "aggressive" is mentioned: Make best judgment calls on all conflicts
- If "test" is mentioned: Run tests after each resolution
- If "ours" is mentioned: Prefer our changes when in doubt
- If "theirs" is mentioned: Prefer their changes when in doubt
- If specific files are mentioned: Only resolve those files

## Process:

1. Check git status and identify conflicts
2. use the github cli to check the PRs and understand the context
3. Think hard about your findings and plan accordingly
4. Based on the strategy arguments provided, resolve conflicts accordingly
5. For each resolution, document what decision was made and why
6. If "test" was specified, run tests after each file resolution
7. Provide detailed summary of all resolutions

## Special handling:

- package-lock.json / yarn.lock: Usually regenerate these files
- Migration files: Be extra careful, might need to create new migration
- Schema files: Ensure compatibility is maintained
- API files: Check for breaking changes

Start by running git status to see all conflicts.