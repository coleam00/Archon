# Debug Issue

Systematically debug and diagnose the reported problem.

## Problem Description

$ARGUMENTS

## Debugging Process

1. **Reproduce the Issue**
   - Get exact steps to reproduce
   - Verify you can see the same problem
   - Note any error messages or logs
   - Document the expected vs actual behavior

2. **Gather Information**

   ```bash
   # Check recent changes
   git log --oneline -10

   # Look for error patterns in logs
   # Search for related error messages
   ```

3. **Isolate the Problem**
   - **Binary Search**: Comment out code sections to narrow down
   - **Git Bisect**: Find when the bug was introduced
   - **Logging**: Add strategic log statements
   - **Debugger**: Set breakpoints if applicable

4. **Common Debugging Strategies**

   ### For Runtime Errors
   - Read the full stack trace
   - Identify the exact line causing the error
   - Check variable values at that point
   - Verify assumptions about data types

   ### For Logic Errors
   - Add print/log statements to trace execution
   - Verify each step produces expected results
   - Check boundary conditions
   - Test with minimal reproducible example

   ### For Performance Issues
   - Add timing measurements
   - Check for N+1 queries
   - Look for inefficient algorithms
   - Profile if necessary

   ### For Integration Issues
   - Verify external service is accessible
   - Check authentication/credentials
   - Validate request/response formats
   - Test with curl/Postman first

5. **Root Cause Analysis**
   - Why did this happen?
   - Why wasn't it caught earlier?
   - Are there similar issues elsewhere?
   - How can we prevent this class of bugs?

6. **Implement Fix**
   - Fix the root cause, not just symptoms
   - Add defensive programming if needed
   - Consider edge cases
   - Keep fix minimal and focused, follow KISS

7. **Verify Resolution**
   - Confirm original issue is fixed
   - Check for regression
   - Test related functionality
   - Add test to prevent recurrence

8. **Document Findings**

   ```markdown
   ## Debug Summary

   ### Issue

   [What was broken]

   ### Root Cause

   [Why it was broken]

   ### Fix

   [What was changed]

   ### Prevention

   [How to avoid similar issues]
   ```

## Debug Checklist

- [ ] Issue reproduced locally
- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Tests added/updated
- [ ] No regressions introduced
- [ ] Documentation updated if needed

Remember: The goal is not just to fix the bug, but to understand why it happened and prevent similar issues in the future.
