#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Command Handlers for GitLab Security Scanning Skill
"""
import sys
from pathlib import Path

# Add src directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from gitleaks_manager import GitleaksManager
from remediation_library import RemediationLibrary
from project_config import ProjectConfig


def get_project_config(gitlab_url: str = None, project_id: str = None):
    """Get project configuration from args, config file, or auto-detect from git remote."""
    config = ProjectConfig()
    
    # Use provided args or fall back to config / auto-detect
    if not gitlab_url or not project_id:
        active = config.get_active_project()
        if active:
            gitlab_url = gitlab_url or active['gitlab_url']
            project_id = project_id or active['id']
        else:
            if not gitlab_url or not project_id:
                print("❌ No active project configured and could not auto-detect from git remote")
                print("   Run: python3 project_config.py to configure projects")
                sys.exit(1)
    
    # Always report active project
    active = config.get_active_project()
    project_name = active.get('name', 'Unknown') if active else 'Unknown'
    print(f"🔗 Active project: {project_name} (ID: {project_id}) @ {gitlab_url}")
    
    return gitlab_url, project_id


def handle_gitleaks_scan(gitlab_url: str = None, project_id: str = None, report_type: str = 'all'):
    """Handle *gitleaks-scan command"""
    gitlab_url, project_id = get_project_config(gitlab_url, project_id)
    
    report_type_label = report_type.upper() if report_type != 'all' else 'ALL'
    print(f"\n🔍 Scanning for {report_type_label} findings...\n")
    
    manager = GitleaksManager(gitlab_url, project_id)
    findings = manager.scan_findings(report_type=report_type)
    
    if not findings:
        print(f"✅ No {report_type_label} findings found\n")
        return
    
    print(f"Found {len(findings)} findings:\n")
    print(f"{'ID':<10} {'Severity':<12} {'Type':<30} {'File':<35} {'Line':<6} {'Status':<12} {'Report':<15} {'FP?'}")
    print("-" * 135)
    
    for f in findings:
        severity_icon = {
            'critical': '🔴',
            'high': '🟠',
            'medium': '🟡',
            'low': '🟢'
        }.get(f['severity'].lower(), '⚪')
        
        # Detect placeholder patterns
        is_placeholder = manager.detect_placeholder_pattern(f)
        fp_indicator = '📝' if is_placeholder else ''
        
        print(f"{f['id']:<10} {severity_icon} {f['severity']:<10} {f['type'][:28]:<30} {f['file'][:33]:<35} {f['line']:<6} {f['status']:<12} {f['report_type']:<15} {fp_indicator}")
    
    print(f"\n📊 Summary:")
    print(f"  Total: {len(findings)}")
    
    # Group by report type
    by_report = {}
    for f in findings:
        rt = f['report_type']
        by_report[rt] = by_report.get(rt, 0) + 1
    
    print(f"  By Report Type:")
    for rt, count in sorted(by_report.items()):
        print(f"    {rt}: {count}")
    
    # Status summary
    resolved = sum(1 for f in findings if f['status'] in ['resolved', 'dismissed'])
    open_count = len(findings) - resolved
    print(f"  Resolved/Dismissed: {resolved}")
    print(f"  Open: {open_count}")
    
    # Count potential false positives
    potential_fp = sum(1 for f in findings if manager.detect_placeholder_pattern(f))
    if potential_fp > 0:
        print(f"  📝 Potential false positives (documentation): {potential_fp}")
        print(f"\n💡 Tip: Use *gitleaks-mark-false-positive to mark documentation examples\n")
    else:
        print()


def handle_gitleaks_mark_false_positive(gitlab_url: str = None, project_id: str = None, finding_ids: list = None):
    """Handle *gitleaks-mark-false-positive command"""
    gitlab_url, project_id = get_project_config(gitlab_url, project_id)
    
    print("\n🔐 Mark Findings as False Positives\n")
    
    manager = GitleaksManager(gitlab_url, project_id)
    findings = manager.scan_findings()
    
    # Filter to open findings only
    open_findings = [f for f in findings if f['status'] not in ['resolved', 'dismissed']]
    
    if not open_findings:
        print("✅ No open findings to mark\n")
        return
    
    # Filter by IDs if specified
    if finding_ids:
        open_findings = [f for f in open_findings if str(f['id']) in finding_ids]
        if not open_findings:
            print(f"❌ No findings found with IDs: {', '.join(finding_ids)}\n")
            return
    
    # Show findings with placeholder detection
    print(f"Found {len(open_findings)} open findings:\n")
    print(f"{'ID':<10} {'Type':<30} {'File':<40} {'FP?'}")
    print("-" * 90)
    
    for f in open_findings:
        is_placeholder = manager.detect_placeholder_pattern(f)
        fp_indicator = '📝 YES' if is_placeholder else ''
        print(f"{f['id']:<10} {f['type']:<30} {f['file']:<40} {fp_indicator}")
    
    print(f"\n📝 = Detected placeholder pattern (likely documentation example)")
    print(f"\nMarking {len(open_findings)} findings as false positives...\n")
    
    # Mark each finding
    success_count = 0
    failed_count = 0
    
    for f in open_findings:
        is_placeholder = manager.detect_placeholder_pattern(f)
        reason = "Documentation example with placeholder text" if is_placeholder else "False positive"
        
        # Use vulnerability ID (not UUID) for dismissal
        if manager.mark_false_positive(f['id'], reason):
            print(f"✅ Marked finding {f['id']} as false positive")
            success_count += 1
        else:
            print(f"❌ Failed to mark finding {f['id']}")
            failed_count += 1
    
    print(f"\n📊 Summary:")
    print(f"  Successfully marked: {success_count}")
    print(f"  Failed: {failed_count}\n")


def handle_gitleaks_remediate(gitlab_url: str = None, project_id: str = None, finding_ids: list = None, dry_run: bool = False):
    """Handle *gitleaks-remediate command"""
    gitlab_url, project_id = get_project_config(gitlab_url, project_id)
    
    print("\n🔧 Auto-Remediation Workflow\n")
    
    # Get local_path from project config
    from project_config import ProjectConfig
    config = ProjectConfig()
    projects = config.config.get('projects', [])
    project = next((p for p in projects if p['id'] == project_id), None)
    
    if not project or not project.get('local_path'):
        print("❌ Error: Project local_path not configured")
        print("   Run: *gitleaks-config to set local_path\n")
        return
    
    local_path = Path(project['local_path'])
    
    manager = GitleaksManager(gitlab_url, project_id)
    library = RemediationLibrary()
    
    # Scan findings
    findings = manager.scan_findings()
    open_findings = [f for f in findings if f['status'] != 'resolved']
    
    if not open_findings:
        print("✅ No open findings to remediate\n")
        return
    
    # Filter by IDs if specified
    if finding_ids:
        open_findings = [f for f in open_findings if str(f['id']) in finding_ids]
    
    print(f"Remediating {len(open_findings)} findings...\n")
    
    success_count = 0
    failed_count = 0
    
    for finding in open_findings:
        print(f"Processing: {finding['type']} in {finding['file']}:{finding['line']}")
        
        # Check for existing script
        script_path = library.get_script(finding['type'])
        
        if not script_path:
            print(f"  ⚠️  No script found, generating new script...")
            # Extract pattern from finding type
            pattern = _get_pattern_for_type(finding['type'])
            script_path = library.create_script(finding['type'], pattern)
            print(f"  ✅ Created: {script_path.name}")
        else:
            print(f"  📚 Using existing script: {script_path.name}")
        
        # Execute remediation
        pattern = _get_pattern_for_type(finding['type'])
        full_file_path = str(local_path / finding['file'])
        result = library.execute_script(
            script_path,
            full_file_path,
            finding['line'],
            pattern,
            dry_run=dry_run
        )
        
        if result['success']:
            print(f"  ✅ Remediation successful")
            if not dry_run:
                # Mark resolved in GitLab with specific remediation details
                remediation_comment = f"Remediated with {script_path.name}: {finding['type']} in {finding['file']}:{finding['line']}"
                if manager.mark_resolved(finding.get('uuid', finding['id']),
                                        comment=remediation_comment,
                                        dismissal_reason='mitigating_control'):
                    print(f"  ✅ Marked resolved in GitLab")
                else:
                    print(f"  ⚠️  Failed to mark resolved in GitLab")
            success_count += 1
        else:
            error_msg = result.get('error', result.get('stderr', result.get('stdout', 'Unknown error')))
            print(f"  ❌ Remediation failed: {error_msg}")
            failed_count += 1
        
        print()
    
    # Summary
    print(f"{'🔍 DRY RUN ' if dry_run else ''}Summary:")
    print(f"  ✅ Successful: {success_count}")
    print(f"  ❌ Failed: {failed_count}")
    print(f"  📊 Success Rate: {(success_count/(success_count+failed_count)*100):.1f}%\n")


def handle_gitleaks_report(gitlab_url: str = None, project_id: str = None, format: str = 'json', include_resolved: bool = False):
    """Handle *gitleaks-report command"""
    gitlab_url, project_id = get_project_config(gitlab_url, project_id)
    
    state_filter = 'all' if include_resolved else 'detected'
    state_msg = 'all findings (including resolved)' if include_resolved else 'active findings only'
    
    print(f"\n📊 Generating Executive Compliance Report ({state_msg})...\n")
    
    manager = GitleaksManager(gitlab_url, project_id)
    findings = manager.scan_findings(state=state_filter)
    
    if not findings:
        print("ℹ️  No findings to report\n")
        return
    
    # Get project name from config
    from project_config import ProjectConfig
    config = ProjectConfig()
    active_project = config.get_active_project()
    project_name = active_project.get('name', 'Unknown Project') if active_project else 'Unknown Project'
    
    # Generate report
    report_file = manager.generate_report(findings, format, project_name)
    
    # Display executive summary
    total = len(findings)
    resolved = sum(1 for f in findings if f['status'] == 'resolved')
    open_count = total - resolved
    compliance_pct = (resolved / total * 100) if total > 0 else 0
    
    # Calculate risk
    by_severity = {}
    for f in findings:
        sev = f['severity']
        if sev not in by_severity:
            by_severity[sev] = {'total': 0, 'resolved': 0, 'open': 0}
        by_severity[sev]['total'] += 1
        if f['status'] == 'resolved':
            by_severity[sev]['resolved'] += 1
        else:
            by_severity[sev]['open'] += 1
    
    critical_open = by_severity.get('critical', {}).get('open', 0)
    high_open = by_severity.get('high', {}).get('open', 0)
    medium_open = by_severity.get('medium', {}).get('open', 0)
    low_open = by_severity.get('low', {}).get('open', 0)
    
    risk_score = (critical_open * 10) + (high_open * 5) + (medium_open * 2) + low_open
    if risk_score <= 20:
        risk_level = 'LOW 🟢'
    elif risk_score <= 50:
        risk_level = 'MEDIUM 🟡'
    elif risk_score <= 80:
        risk_level = 'HIGH 🟠'
    else:
        risk_level = 'CRITICAL 🔴'
    
    print(f"Executive Compliance Report Generated\n")
    print(f"📋 Project: {project_name}")
    print(f"🔗 GitLab: {gitlab_url}")
    print(f"🆔 Project ID: {project_id}\n")
    print(f"📈 Overall Statistics:")
    print(f"  Total Findings: {total}")
    print(f"  Resolved: {resolved} ✅")
    print(f"  Open: {open_count} ⚠️")
    print(f"  Compliance: {compliance_pct:.1f}%")
    print(f"  Risk Level: {risk_level}")
    
    print(f"\n📊 By Severity:")
    for sev in ['critical', 'high', 'medium', 'low']:
        if sev in by_severity:
            data = by_severity[sev]
            icon = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🟢'}[sev]
            print(f"  {icon} {sev.capitalize()}: {data['resolved']}/{data['total']} resolved")
    
    print(f"\n💾 Report saved: {report_file}\n")


def handle_gitleaks_scripts():
    """Handle *gitleaks-scripts command"""
    print("\n📚 Remediation Script Library\n")
    
    library = RemediationLibrary()
    scripts = library.list_scripts()
    
    if not scripts:
        print("ℹ️  No scripts in library yet.")
        print("Scripts will be auto-generated during remediation.\n")
        return
    
    print(f"Available Scripts: {len(scripts)}\n")
    
    for script in scripts:
        print(f"  📄 {script['name']}")
        print(f"     Type: {script['type']}")
        print(f"     Path: {script['path']}\n")


def _get_pattern_for_type(finding_type: str) -> str:
    """Get regex pattern for finding type"""
    patterns = {
        'aws_access_key': r'AKIA[0-9A-Z]{16}',
        'github_token': r'ghp_[a-zA-Z0-9]{36}',
        'generic_api_key': r'api[_-]?key[\'"]?\s*[:=]\s*[\'"]?[a-zA-Z0-9]{32,}',
        'private_key': r'-----BEGIN.*PRIVATE KEY-----'
    }
    
    normalized = finding_type.lower().replace(' ', '_').replace('-', '_')
    return patterns.get(normalized, r'[a-zA-Z0-9]{32,}')


def handle_gitleaks_posture():
    """Handle *gitleaks-posture command"""
    from posture_report import generate_consolidated_report
    generate_consolidated_report()


def main():
    """CLI interface for testing"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Gitleaks Compliance Commands')
    parser.add_argument('--gitlab-url', help='GitLab URL (optional if configured)')
    parser.add_argument('--project-id', help='Project ID (optional if configured)')
    parser.add_argument('command', choices=['scan', 'remediate', 'report', 'scripts', 'config', 'posture', 'mark-false-positive'])
    parser.add_argument('--format', choices=['json', 'csv', 'markdown'], default='json', help='Report format')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-ids', nargs='+', help='Specific finding IDs to remediate')
    
    args = parser.parse_args()
    
    if args.command == 'config':
        # Run project configuration
        from project_config import main as config_main
        config_main()
    elif args.command == 'posture':
        handle_gitleaks_posture()
    elif args.command == 'scan':
        handle_gitleaks_scan(args.gitlab_url, args.project_id)
    elif args.command == 'remediate':
        handle_gitleaks_remediate(args.gitlab_url, args.project_id, args.finding_ids, args.dry_run)
    elif args.command == 'report':
        handle_gitleaks_report(args.gitlab_url, args.project_id, args.format)
    elif args.command == 'scripts':
        handle_gitleaks_scripts()
    elif args.command == 'mark-false-positive':
        handle_gitleaks_mark_false_positive(args.gitlab_url, args.project_id, args.finding_ids)


if __name__ == "__main__":
    main()
