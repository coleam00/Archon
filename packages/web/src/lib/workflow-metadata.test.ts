import { describe, expect, test } from 'bun:test';
import {
  parseWorkflowDescription,
  getWorkflowDisplayName,
  getWorkflowCategory,
  getWorkflowTags,
  getWorkflowIconName,
} from './workflow-metadata';

describe('parseWorkflowDescription', () => {
  test('parses structured description with all sections', () => {
    const description = `Use when: User wants to report a bug or problem as a GitHub issue with automated reproduction.
Triggers: "create issue", "file a bug", "report this bug".
Does: Classifies problem area -> gathers context -> creates issue.
NOT for: Feature requests, enhancements, or non-bug work.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe(
      'User wants to report a bug or problem as a GitHub issue with automated reproduction.'
    );
    expect(result.triggers).toEqual(['create issue', 'file a bug', 'report this bug']);
    expect(result.does).toBe('Classifies problem area -> gathers context -> creates issue.');
    expect(result.constraints).toBe('Feature requests, enhancements, or non-bug work.');
    expect(result.raw).toBe(description);
  });

  test('parses description with multi-line sections', () => {
    const description = `Use when: User wants to report a bug or problem as a GitHub issue with automated reproduction.
Triggers: "create issue", "file a bug", "report this bug", "open an issue for",
          "create github issue", "report issue", "log this bug".
Does: Classifies problem area (haiku) -> gathers context in parallel (templates, git state, duplicates) ->
      investigates relevant code -> reproduces the issue using area-specific tools (agent-browser, CLI, DB queries) ->
      gates on reproduction success -> creates issue with full evidence OR reports back if cannot reproduce.
NOT for: Feature requests, enhancements, or non-bug work. Only for bugs/problems.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toContain('report a bug');
    expect(result.triggers.length).toBeGreaterThanOrEqual(3);
    expect(result.triggers).toContain('create issue');
    expect(result.triggers).toContain('report issue');
    expect(result.does).toContain('Classifies problem area');
    expect(result.constraints).toContain('Feature requests');
  });

  test('handles "Handles:" and "Capability:" fallbacks (archon-assist style)', () => {
    const description = `Use when: No other workflow matches the request.
Handles: Questions, debugging, exploration, one-off tasks, explanations, CI failures, general help.
Capability: Full Claude Code agent with all tools available.
Note: Will inform user when assist mode is used for tracking.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe('No other workflow matches the request.');
    expect(result.does).toBe('Full Claude Code agent with all tools available.');
  });

  test('parses Korean default workflow sections', () => {
    const description = `사용할 때: pull request를 포괄적으로 code review하고 자동 수정까지 원할 때.
트리거 예시: "PR 리뷰해줘", "review PR #123", "comprehensive review".
하는 일: PR을 main과 동기화 -> 전문 review agent 실행 -> findings 종합.
사용하지 않을 때: PR에 대한 짧은 질문, CI 상태 확인.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe(
      'pull request를 포괄적으로 code review하고 자동 수정까지 원할 때.'
    );
    expect(result.triggers).toEqual(['PR 리뷰해줘', 'review PR #123', 'comprehensive review']);
    expect(result.does).toBe('PR을 main과 동기화 -> 전문 review agent 실행 -> findings 종합.');
    expect(result.constraints).toBe('PR에 대한 짧은 질문, CI 상태 확인.');
  });

  test('parses mixed Korean and English workflow sections', () => {
    const description = `사용할 때: 기존 plan을 바탕으로 feature를 구현할 때.
Triggers: implement plan, feature work, ship this
Does: Runs implementation loop -> validates changes.
사용하지 않을 때: plan 작성.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe('기존 plan을 바탕으로 feature를 구현할 때.');
    expect(result.triggers).toEqual(['implement plan', 'feature work', 'ship this']);
    expect(result.does).toBe('Runs implementation loop -> validates changes.');
    expect(result.constraints).toBe('plan 작성.');
  });

  test('handles Korean "처리 범위" and "역량" fallbacks', () => {
    const description = `처리 범위: 질문, 디버깅, 탐색, 일반적인 도움.
역량: 모든 도구를 사용할 수 있는 전체 Claude Code agent.
참고: assist mode가 사용되었음을 알린다.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe('질문, 디버깅, 탐색, 일반적인 도움.');
    expect(result.does).toBe('모든 도구를 사용할 수 있는 전체 Claude Code agent.');
    expect(result.triggers).toEqual([]);
  });

  test('returns raw description when no structured sections found', () => {
    const description = 'A simple workflow that does something useful.';
    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe('');
    expect(result.triggers).toEqual([]);
    expect(result.does).toBe('');
    expect(result.constraints).toBe('');
    expect(result.raw).toBe(description);
  });

  test('handles empty description', () => {
    const result = parseWorkflowDescription('');

    expect(result.whenToUse).toBe('');
    expect(result.triggers).toEqual([]);
    expect(result.does).toBe('');
    expect(result.constraints).toBe('');
    expect(result.raw).toBe('');
  });

  test('handles description with only "Use when:" section', () => {
    const description = 'Use when: Implementing a feature from an existing plan.';
    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe('Implementing a feature from an existing plan.');
    expect(result.triggers).toEqual([]);
  });

  test('handles CRLF line endings in description', () => {
    const crlf = 'Use when: Implementing a feature.\r\nDoes: Runs implementation loop.';
    const result = parseWorkflowDescription(crlf);
    expect(result.whenToUse).toBe('Implementing a feature.');
    expect(result.does).toBe('Runs implementation loop.');
  });

  test('parses unquoted comma-separated triggers', () => {
    const description = `Use when: Something happens.
Triggers: push, pull_request, workflow_dispatch
Does: Runs things.`;
    const result = parseWorkflowDescription(description);
    expect(result.triggers).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  });

  test('parses "Input:" followed by "Does:" correctly', () => {
    const description = `Use when: Implementing a feature from an existing plan.
Input: Path to a plan file ($ARTIFACTS_DIR/plan.md) or GitHub issue containing a plan.
Does: Implements the plan with validation loops -> creates pull request.
NOT for: Creating plans (plans should be created separately), bug fixes, code reviews.`;

    const result = parseWorkflowDescription(description);

    expect(result.whenToUse).toBe('Implementing a feature from an existing plan.');
    expect(result.does).toBe('Implements the plan with validation loops -> creates pull request.');
    expect(result.constraints).toContain('Creating plans');
  });

  test('preserves repeated Korean constraint sections', () => {
    const description = `사용할 때: guided development를 안내받고 싶을 때.
트리거 예시: "piv", "guided development".
사용하지 않을 때: 계획 없는 자율 구현.
사용하지 않을 때: PRD 작성.`;

    const result = parseWorkflowDescription(description);

    expect(result.constraints).toBe('계획 없는 자율 구현.\nPRD 작성.');
  });
});

describe('getWorkflowDisplayName', () => {
  test('strips archon- prefix and converts to title case', () => {
    expect(getWorkflowDisplayName('archon-create-issue')).toBe('Create Issue');
    expect(getWorkflowDisplayName('archon-feature-development')).toBe('Feature Development');
  });

  test('preserves known acronyms (PR, CI, DAG)', () => {
    expect(getWorkflowDisplayName('archon-comprehensive-pr-review')).toBe(
      'Comprehensive PR Review'
    );
    expect(getWorkflowDisplayName('archon-ralph-dag')).toBe('Ralph DAG');
    expect(getWorkflowDisplayName('archon-interactive-prd')).toBe('Interactive PRD');
  });

  test('handles names without archon- prefix', () => {
    expect(getWorkflowDisplayName('my-custom-workflow')).toBe('My Custom Workflow');
  });

  test('handles single-word names', () => {
    expect(getWorkflowDisplayName('archon-assist')).toBe('Assist');
  });
});

describe('getWorkflowCategory', () => {
  test('categorizes review workflows', () => {
    expect(getWorkflowCategory('archon-comprehensive-pr-review', 'Review a PR')).toBe(
      'Code Review'
    );
    expect(getWorkflowCategory('archon-smart-pr-review', 'Smart PR review')).toBe('Code Review');
  });

  test('categorizes automation workflows', () => {
    expect(getWorkflowCategory('archon-create-issue', 'Create GitHub issue')).toBe('Automation');
    expect(getWorkflowCategory('archon-ralph-dag', 'Ralph implementation loop')).toBe('Automation');
    expect(getWorkflowCategory('archon-refactor-safely', 'Refactor code safely')).toBe(
      'Automation'
    );
  });

  test('categorizes CI/CD workflows', () => {
    expect(getWorkflowCategory('archon-validate-pr', 'Validate PR checks')).toBe('CI/CD');
    expect(getWorkflowCategory('archon-test-loop-dag', 'Run test loop')).toBe('CI/CD');
  });

  test('does not miscategorize workflows with "ci" as substring', () => {
    expect(getWorkflowCategory('archon-decision-tree', 'Routes decisions')).toBe('Development');
    expect(getWorkflowCategory('special-analyzer', 'Classifies problem area')).toBe('Development');
  });

  test('returns Development as default for unknown workflows', () => {
    expect(getWorkflowCategory('my-custom-workflow', '')).toBe('Development');
  });

  test('categorizes development workflows', () => {
    expect(getWorkflowCategory('archon-feature-development', 'Implement a feature')).toBe(
      'Development'
    );
    expect(getWorkflowCategory('archon-assist', 'General help')).toBe('Development');
    expect(getWorkflowCategory('archon-idea-to-pr', 'From idea to PR')).toBe('Development');
  });
});

describe('getWorkflowTags', () => {
  test('derives tags from name and description', () => {
    const parsed = parseWorkflowDescription(
      'Use when: Reviewing a GitHub PR.\nDoes: Runs parallel agents to review.'
    );
    const tags = getWorkflowTags('archon-comprehensive-pr-review', parsed);

    expect(tags).toContain('GitHub');
    expect(tags).toContain('Review');
    expect(tags).toContain('Agent');
  });

  test('returns empty array when no tags match', () => {
    const parsed = parseWorkflowDescription('A simple workflow.');
    const tags = getWorkflowTags('simple', parsed);
    expect(tags).toEqual([]);
  });

  test('deduplicates tags', () => {
    const parsed = parseWorkflowDescription('Does: review PR on GitHub for GitHub issues');
    const tags = getWorkflowTags('archon-pr-review', parsed);
    const githubCount = tags.filter(t => t === 'GitHub').length;
    expect(githubCount).toBeLessThanOrEqual(1);
  });
});

describe('getWorkflowIconName', () => {
  test('maps issue/bug workflows to Bug icon', () => {
    expect(getWorkflowIconName('archon-create-issue', 'Automation')).toBe('Bug');
    expect(getWorkflowIconName('archon-fix-github-issue', 'Automation')).toBe('Bug');
  });

  test('maps review workflows to Eye icon', () => {
    expect(getWorkflowIconName('archon-comprehensive-pr-review', 'Code Review')).toBe('Eye');
  });

  test('maps conflict workflows to GitMerge icon', () => {
    expect(getWorkflowIconName('archon-resolve-conflicts', 'Automation')).toBe('GitMerge');
  });

  test('maps feature workflows to Rocket icon', () => {
    expect(getWorkflowIconName('archon-feature-development', 'Development')).toBe('Rocket');
  });

  test('maps ralph to Bot icon', () => {
    expect(getWorkflowIconName('archon-ralph-dag', 'Automation')).toBe('Bot');
  });

  test('falls back to category-based icon', () => {
    expect(getWorkflowIconName('unknown-workflow', 'Code Review')).toBe('Eye');
    expect(getWorkflowIconName('unknown-workflow', 'CI/CD')).toBe('TestTube');
    expect(getWorkflowIconName('unknown-workflow', 'Automation')).toBe('Zap');
    expect(getWorkflowIconName('unknown-workflow', 'Development')).toBe('Rocket');
  });
});
