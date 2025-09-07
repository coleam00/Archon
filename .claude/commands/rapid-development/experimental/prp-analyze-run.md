# Analyze PRP Results

## PRP File: $ARGUMENTS

Post-execution analysis of a PRP implementation to capture lessons learned, success metrics, and template improvements.

## Analysis Process

1. **Execution Metrics Collection**
   - Measure actual vs estimated token usage
   - Track implementation time and iterations
   - Document test failures and fixes
   - Analyze code quality metrics

2. **Success Pattern Analysis**
   - Identify what worked well
   - Extract reusable patterns
   - Document effective context elements
   - Capture successful validation strategies

3. **Failure Pattern Learning**
   - Document encountered issues
   - Analyze root causes
   - Create prevention strategies
   - Update known gotchas database

4. **Template Improvement Recommendations**
   - Identify context gaps
   - Suggest validation enhancements
   - Recommend documentation updates
   - Propose new anti-patterns

5. **Knowledge Base Updates**
   - Add new failure patterns to database
   - Update success metrics
   - Enhance similar feature detection
   - Improve confidence scoring

## Analysis Framework

### Metrics Collection

```bash
# Collect implementation metrics
echo "Collecting execution metrics..."

# Get git statistics
COMMITS_DURING_IMPL=$(git rev-list --count HEAD --since="2 hours ago")
FILES_CHANGED=$(git diff --name-only HEAD~$COMMITS_DURING_IMPL HEAD | wc -l)
LINES_ADDED=$(git diff --shortstat HEAD~$COMMITS_DURING_IMPL HEAD | grep -o '[0-9]* insertion' | grep -o '[0-9]*' || echo 0)
LINES_DELETED=$(git diff --shortstat HEAD~$COMMITS_DURING_IMPL HEAD | grep -o '[0-9]* deletion' | grep -o '[0-9]*' || echo 0)

# Get test results
TEST_RESULTS=$(pytest tests/ --tb=no -q 2>&1 | tail -n 1)
TEST_COUNT=$(echo "$TEST_RESULTS" | grep -o '[0-9]* passed' | grep -o '[0-9]*' || echo 0)
TEST_FAILURES=$(echo "$TEST_RESULTS" | grep -o '[0-9]* failed' | grep -o '[0-9]*' || echo 0)

# Get code quality metrics
RUFF_ISSUES=$(ruff check . 2>&1 | grep -c "error\|warning" || echo 0)
MYPY_ERRORS=$(mypy . 2>&1 | grep -c "error:" || echo 0)

echo "📊 Implementation Metrics:"
echo "- Commits: $COMMITS_DURING_IMPL"
echo "- Files changed: $FILES_CHANGED"
echo "- Lines added: $LINES_ADDED"
echo "- Lines deleted: $LINES_DELETED"
echo "- Tests passing: $TEST_COUNT"
echo "- Tests failing: $TEST_FAILURES"
echo "- Ruff issues: $RUFF_ISSUES"
echo "- MyPy errors: $MYPY_ERRORS"
```

### Context Effectiveness Analysis

```python
# Analyze which context elements were most valuable
def analyze_context_effectiveness(prp_file):
    """Analyze which parts of the PRP were most effective."""

    # Read the PRP file
    with open(prp_file, 'r') as f:
        prp_content = f.read()

    # Extract context elements
    context_elements = {
        'documentation_urls': re.findall(r'url: (https?://[^\s]+)', prp_content),
        'file_references': re.findall(r'file: ([^\s]+)', prp_content),
        'gotchas': re.findall(r'# CRITICAL: ([^\n]+)', prp_content),
        'patterns': re.findall(r'# PATTERN: ([^\n]+)', prp_content),
        'examples': re.findall(r'examples/([^\s]+)', prp_content)
    }

    # Analyze git history to see which files were actually referenced
    git_files = subprocess.check_output(['git', 'log', '--name-only', '--pretty=format:', '--since=2 hours ago']).decode().strip().split('\n')

    # Calculate effectiveness scores
    effectiveness_scores = {}
    for category, elements in context_elements.items():
        if elements:
            referenced_count = sum(1 for element in elements if any(element in git_file for git_file in git_files))
            effectiveness_scores[category] = referenced_count / len(elements) * 100
        else:
            effectiveness_scores[category] = 0

    return effectiveness_scores
```

### Failure Pattern Detection

```python
# Extract failure patterns from implementation
def extract_failure_patterns():
    """Extract new failure patterns from the implementation."""

    patterns = []

    # Check git commit messages for failure indicators
    commit_messages = subprocess.check_output(['git', 'log', '--oneline', '--since=2 hours ago']).decode().strip().split('\n')

    failure_indicators = ['fix', 'error', 'bug', 'issue', 'problem', 'typo', 'mistake']

    for message in commit_messages:
        if any(indicator in message.lower() for indicator in failure_indicators):
            # Extract the type of failure
            if 'async' in message.lower():
                patterns.append({
                    'type': 'async_context_issue',
                    'description': message,
                    'frequency': 'high',
                    'solution': 'Always use async/await consistently'
                })
            elif 'import' in message.lower():
                patterns.append({
                    'type': 'import_error',
                    'description': message,
                    'frequency': 'medium',
                    'solution': 'Verify all imports before implementation'
                })
            elif 'type' in message.lower():
                patterns.append({
                    'type': 'type_error',
                    'description': message,
                    'frequency': 'medium',
                    'solution': 'Run mypy validation before proceeding'
                })

    return patterns
```

### Success Pattern Identification

```python
# Identify successful patterns from the implementation
def identify_success_patterns():
    """Identify patterns that led to successful implementation."""

    success_patterns = []

    # Check for clean test runs
    test_output = subprocess.check_output(['pytest', 'tests/', '--tb=no', '-q']).decode()
    if 'passed' in test_output and 'failed' not in test_output:
        success_patterns.append({
            'pattern': 'comprehensive_testing',
            'description': 'All tests passed on implementation',
            'reuse_recommendation': 'Include similar test coverage in future PRPs'
        })

    # Check for clean code quality
    ruff_output = subprocess.check_output(['ruff', 'check', '.', '--quiet']).decode()
    if not ruff_output.strip():
        success_patterns.append({
            'pattern': 'clean_code_style',
            'description': 'No style issues detected',
            'reuse_recommendation': 'Maintain consistent style patterns'
        })

    # Check for proper error handling
    python_files = subprocess.check_output(['find', '.', '-name', '*.py', '-not', '-path', './venv*']).decode().strip().split('\n')

    error_handling_count = 0
    for file in python_files:
        if file.strip():
            with open(file, 'r') as f:
                content = f.read()
                if 'try:' in content and 'except' in content:
                    error_handling_count += 1

    if error_handling_count > 0:
        success_patterns.append({
            'pattern': 'proper_error_handling',
            'description': f'Error handling implemented in {error_handling_count} files',
            'reuse_recommendation': 'Continue including error handling patterns in PRPs'
        })

    return success_patterns
```

## Knowledge Base Updates

### Failure Pattern Database

```yaml
# PRPs/knowledge_base/failure_patterns.yaml
failure_patterns:
  - id: "async_context_mixing"
    description: "Mixing sync and async code contexts"
    frequency: "high"
    detection_signs:
      - "RuntimeError: cannot be called from a running event loop"
      - "SyncError in async context"
    prevention:
      - "Always use async/await consistently"
      - "Use asyncio.run() for top-level async calls"
    related_libraries: ["asyncio", "aiohttp", "fastapi"]

  - id: "pydantic_v2_breaking_changes"
    description: "Pydantic v2 syntax changes"
    frequency: "medium"
    detection_signs:
      - "ValidationError: Field required"
      - "AttributeError: 'Field' object has no attribute"
    prevention:
      - "Use Field() instead of ... for optional fields"
      - "Update to v2 syntax for validators"
    related_libraries: ["pydantic", "fastapi"]

  - id: "environment_variable_missing"
    description: "Missing environment variables"
    frequency: "medium"
    detection_signs:
      - "KeyError: 'API_KEY'"
      - "None type has no attribute"
    prevention:
      - "Always check .env.example completeness"
      - "Use default values in config"
    related_libraries: ["python-dotenv", "pydantic-settings"]
```

### Success Metrics Database

```yaml
# PRPs/knowledge_base/success_metrics.yaml
success_metrics:
  - feature_type: "api_integration"
    avg_token_usage: 2500
    avg_implementation_time: 35
    success_rate: 85
    common_patterns:
      - "async http client usage"
      - "proper error handling"
      - "rate limiting implementation"

  - feature_type: "database_operations"
    avg_token_usage: 1800
    avg_implementation_time: 25
    success_rate: 92
    common_patterns:
      - "sqlalchemy async sessions"
      - "proper migration handling"
      - "connection pooling"

  - feature_type: "cli_applications"
    avg_token_usage: 1200
    avg_implementation_time: 20
    success_rate: 95
    common_patterns:
      - "click or typer usage"
      - "proper argument parsing"
      - "colored output"
```

## Analysis Report Generation

```python
# Generate comprehensive analysis report
def generate_analysis_report(prp_file):
    """Generate a comprehensive analysis report."""

    report = {
        'prp_file': prp_file,
        'timestamp': datetime.now().isoformat(),
        'metrics': collect_metrics(),
        'context_effectiveness': analyze_context_effectiveness(prp_file),
        'failure_patterns': extract_failure_patterns(),
        'success_patterns': identify_success_patterns(),
        'recommendations': generate_recommendations(),
        'confidence_validation': validate_confidence_score(prp_file)
    }

    # Save to knowledge base
    save_to_knowledge_base(report)

    # Generate human-readable report
    return format_analysis_report(report)

def collect_metrics():
    """Collect implementation metrics."""
    # Git statistics
    commits = get_commit_count_since_hours_ago(2)
    files_changed = get_files_changed_in_commits(commits)
    lines_stats = get_line_change_stats(commits)

    # Test results
    test_results = run_test_suite()

    # Code quality
    quality_metrics = get_code_quality_metrics()

    return {
        'commits': commits,
        'files_changed': files_changed,
        'lines_added': lines_stats['added'],
        'lines_deleted': lines_stats['deleted'],
        'tests_passed': test_results['passed'],
        'tests_failed': test_results['failed'],
        'ruff_issues': quality_metrics['ruff_issues'],
        'mypy_errors': quality_metrics['mypy_errors'],
        'implementation_time_minutes': calculate_implementation_time()
    }

def generate_recommendations():
    """Generate recommendations for future PRPs."""
    recommendations = []

    # Analyze current implementation for improvement opportunities
    metrics = collect_metrics()

    if metrics['tests_failed'] > 0:
        recommendations.append({
            'type': 'testing',
            'priority': 'high',
            'suggestion': 'Add more comprehensive test cases to PRP template',
            'rationale': f"Had {metrics['tests_failed']} test failures during implementation"
        })

    if metrics['ruff_issues'] > 5:
        recommendations.append({
            'type': 'code_quality',
            'priority': 'medium',
            'suggestion': 'Include stricter style checking in validation loop',
            'rationale': f"Found {metrics['ruff_issues']} style issues"
        })

    if metrics['implementation_time_minutes'] > 60:
        recommendations.append({
            'type': 'complexity',
            'priority': 'medium',
            'suggestion': 'Break down complex features into smaller PRPs',
            'rationale': f"Implementation took {metrics['implementation_time_minutes']} minutes"
        })

    return recommendations

def validate_confidence_score(prp_file):
    """Validate whether the original confidence score was accurate."""
    # Extract original confidence score from PRP
    with open(prp_file, 'r') as f:
        content = f.read()

    confidence_match = re.search(r'Confidence Score: (\d+)/10', content)
    original_confidence = int(confidence_match.group(1)) if confidence_match else None

    # Calculate actual success indicators
    metrics = collect_metrics()

    # Score based on actual outcomes
    actual_score = 10

    if metrics['tests_failed'] > 0:
        actual_score -= 2
    if metrics['mypy_errors'] > 0:
        actual_score -= 1
    if metrics['ruff_issues'] > 10:
        actual_score -= 1
    if metrics['implementation_time_minutes'] > 90:
        actual_score -= 2
    if metrics['commits'] > 10:  # Too many iterations
        actual_score -= 1

    return {
        'original_confidence': original_confidence,
        'actual_score': max(actual_score, 1),
        'accuracy': abs(original_confidence - actual_score) <= 2 if original_confidence else None
    }
```

## Report Output Format

```yaml
📊 PRP Analysis Report
======================

🎯 Implementation Summary:
- PRP File: {prp_file}
- Execution Date: {timestamp}
- Overall Success: [SUCCESS/PARTIAL/FAILED]

📈 Metrics:
- Commits during implementation: {commits}
- Files changed: {files_changed}
- Lines added/deleted: {lines_added}/{lines_deleted}
- Implementation time: {implementation_time_minutes} minutes
- Tests: {tests_passed} passed, {tests_failed} failed
- Code quality: {ruff_issues} style issues, {mypy_errors} type errors

🎯 Context Effectiveness:
- Documentation URLs: {effectiveness_percentage}% referenced
- File references: {effectiveness_percentage}% used
- Examples: {effectiveness_percentage}% followed
- Gotchas: {effectiveness_percentage}% prevented issues

🔍 Patterns Discovered:
Success Patterns:
{for pattern in success_patterns}
  ✅ {pattern.description}
     → Reuse: {pattern.reuse_recommendation}

Failure Patterns:
{for pattern in failure_patterns}
  ❌ {pattern.description}
     → Prevention: {pattern.solution}

🎯 Confidence Score Validation:
- Original estimate: {original_confidence}/10
- Actual performance: {actual_score}/10
- Prediction accuracy: {accuracy ? "Good" : "Needs improvement"}

💡 Recommendations for Future PRPs:
{for rec in recommendations}
  [{rec.priority}] {rec.suggestion}
  Reason: {rec.rationale}

📚 Knowledge Base Updates:
- New failure patterns: {new_failure_patterns_count}
- Updated success metrics: {updated_metrics_count}
- Template improvements: {template_improvements_count}
```

## Knowledge Base Integration

### Update Failure Patterns Database

```bash
# Update the failure patterns database
echo "Updating failure patterns database..."

# Add new patterns to PRPs/knowledge_base/failure_patterns.yaml
python3 -c "
import yaml
import sys
from datetime import datetime

# Load existing patterns
try:
    with open('PRPs/knowledge_base/failure_patterns.yaml', 'r') as f:
        db = yaml.safe_load(f) or {'failure_patterns': []}
except FileNotFoundError:
    db = {'failure_patterns': []}

# Add new patterns from analysis
new_patterns = extract_failure_patterns()
for pattern in new_patterns:
    # Check if pattern already exists
    existing = next((p for p in db['failure_patterns'] if p.get('id') == pattern['type']), None)

    if existing:
        # Update frequency if pattern seen again
        existing['last_seen'] = datetime.now().isoformat()
        existing['frequency'] = 'high' if existing.get('frequency') == 'medium' else existing.get('frequency', 'medium')
    else:
        # Add new pattern
        db['failure_patterns'].append({
            'id': pattern['type'],
            'description': pattern['description'],
            'frequency': pattern['frequency'],
            'solution': pattern['solution'],
            'first_seen': datetime.now().isoformat(),
            'last_seen': datetime.now().isoformat()
        })

# Save updated database
with open('PRPs/knowledge_base/failure_patterns.yaml', 'w') as f:
    yaml.dump(db, f, default_flow_style=False)

print(f'Updated failure patterns database with {len(new_patterns)} new patterns')
"
```

### Update Success Metrics

```bash
# Update success metrics for this feature type
echo "Updating success metrics..."

python3 -c "
import yaml
from datetime import datetime

# Determine feature type from PRP content
feature_type = determine_feature_type('$PRP_FILE')
metrics = collect_metrics()

# Load existing metrics
try:
    with open('PRPs/knowledge_base/success_metrics.yaml', 'r') as f:
        db = yaml.safe_load(f) or {'success_metrics': []}
except FileNotFoundError:
    db = {'success_metrics': []}

# Find or create entry for this feature type
existing = next((m for m in db['success_metrics'] if m.get('feature_type') == feature_type), None)

if existing:
    # Update running averages
    existing['implementations'] = existing.get('implementations', 0) + 1
    existing['avg_token_usage'] = update_running_average(
        existing['avg_token_usage'],
        metrics['estimated_tokens'],
        existing['implementations']
    )
    existing['avg_implementation_time'] = update_running_average(
        existing['avg_implementation_time'],
        metrics['implementation_time_minutes'],
        existing['implementations']
    )
    # Update success rate based on test results
    success = 1 if metrics['tests_failed'] == 0 else 0
    existing['success_rate'] = update_running_average(
        existing['success_rate'],
        success * 100,
        existing['implementations']
    )
else:
    # Create new entry
    success_rate = 100 if metrics['tests_failed'] == 0 else 0
    db['success_metrics'].append({
        'feature_type': feature_type,
        'implementations': 1,
        'avg_token_usage': metrics.get('estimated_tokens', 0),
        'avg_implementation_time': metrics['implementation_time_minutes'],
        'success_rate': success_rate,
        'last_updated': datetime.now().isoformat()
    })

# Save updated metrics
with open('PRPs/knowledge_base/success_metrics.yaml', 'w') as f:
    yaml.dump(db, f, default_flow_style=False)
"
```

## Template Improvement Suggestions

```python
# Generate specific template improvements
def suggest_template_improvements():
    """Suggest specific improvements to PRP templates."""

    improvements = []

    # Analyze what context was missing
    missing_context = analyze_missing_context()
    for context in missing_context:
        improvements.append({
            'section': 'Context',
            'improvement': f'Add {context["type"]} validation to template',
            'rationale': f'Missing {context["description"]} caused implementation delay'
        })

    # Analyze validation gaps
    validation_gaps = analyze_validation_gaps()
    for gap in validation_gaps:
        improvements.append({
            'section': 'Validation',
            'improvement': f'Add {gap["type"]} validation step',
            'rationale': f'Would have caught {gap["issue"]} earlier'
        })

    # Analyze documentation gaps
    doc_gaps = analyze_documentation_gaps()
    for gap in doc_gaps:
        improvements.append({
            'section': 'Documentation',
            'improvement': f'Include {gap["type"]} documentation',
            'rationale': f'Had to research {gap["topic"]} during implementation'
        })

    return improvements

# Auto-generate improved template
def generate_improved_template():
    """Generate an improved template based on lessons learned."""

    base_template = load_template('PRPs/templates/prp_base.md')
    improvements = suggest_template_improvements()

    # Apply improvements to template
    improved_template = apply_improvements(base_template, improvements)

    # Save as versioned template
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    save_template(f'PRPs/templates/prp_base_v{timestamp}.md', improved_template)

    return improved_template
```

## Auto-Update Mechanism

```bash
# Auto-update PRP templates based on analysis
echo "Checking for template updates..."

ANALYSIS_COUNT=$(find PRPs/analysis_reports/ -name "*.yaml" | wc -l)
TEMPLATE_VERSION=$(ls PRPs/templates/prp_base_v*.md 2>/dev/null | tail -n1 | grep -o 'v[0-9_]*' || echo "v1")

# If we have 5+ analyses since last template update, generate new version
if [ "$ANALYSIS_COUNT" -ge 5 ]; then
    echo "Generating improved template based on recent analyses..."
    python3 -c "
from analysis_utils import generate_improved_template
improved_template = generate_improved_template()
print('Generated improved template with latest learnings')
"
fi
```

## Integration with Execute Command

Update the execute-prp command to automatically run analysis after completion:

```bash
# Add to end of execute-prp.md
echo "Running post-execution analysis..."
analyze-prp-results "$PRP_FILE"

echo "✅ Implementation complete with analysis"
echo "📊 Check PRPs/analysis_reports/ for detailed analysis"
echo "💡 Template improvements will be applied to future PRPs"
```

## Continuous Improvement Loop

This analysis system creates a continuous improvement loop:

1. **Execute PRP** → Implement feature
2. **Analyze Results** → Extract patterns and metrics
3. **Update Knowledge Base** → Store learnings
4. **Improve Templates** → Apply learnings to future PRPs
5. **Better Context** → Higher success rates

The system learns from each implementation, making future PRPs more effective and reducing failure rates over time.
