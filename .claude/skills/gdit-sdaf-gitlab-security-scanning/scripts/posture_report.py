#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Consolidated Security Posture Report
Scans all configured projects and generates unified security view
"""
import sys
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from project_config import ProjectConfig


def calculate_security_score(findings: List[Dict]) -> int:
    """Calculate security score based on findings"""
    score = 100
    
    for finding in findings:
        severity = finding.get('severity', '').upper()
        if severity == 'CRITICAL':
            score -= 10
        elif severity == 'HIGH':
            score -= 5
        elif severity == 'MEDIUM':
            score -= 2
        elif severity == 'LOW':
            score -= 1
    
    return max(0, score)


def aggregate_findings_by_severity(findings: List[Dict]) -> Dict[str, int]:
    """Aggregate findings by severity"""
    counts = {'CRITICAL': 0, 'HIGH': 0, 'MEDIUM': 0, 'LOW': 0}
    
    for finding in findings:
        severity = finding.get('severity', '').upper()
        if severity in counts:
            counts[severity] += 1
    
    return counts


def generate_consolidated_report():
    """Generate consolidated security posture report"""
    config = ProjectConfig()
    projects = config.list_projects()
    
    if not projects:
        print("\n❌ No projects configured")
        print("Run: python3 project_config.py to add projects\n")
        return
    
    print("\n🔐 Consolidated Security Posture Report")
    print(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    print(f"Scanning {len(projects)} project(s)...\n")
    
    all_findings = []
    project_results = []
    
    # Import here to avoid dependency issues during module load
    try:
        from gitleaks_manager import GitleaksManager
    except ImportError as e:
        print(f"❌ Error: {e}")
        print("Ensure gitlab-integration extension is installed")
        return
    
    for project in projects:
        print(f"📊 Scanning: {project['name']} (ID: {project['id']})...", end=' ')
        
        try:
            manager = GitleaksManager(
                project_id=project['id'],
                gitlab_url=project['gitlab_url']
            )
            
            findings = manager.scan_findings()
            severity_counts = aggregate_findings_by_severity(findings)
            score = calculate_security_score(findings)
            
            project_results.append({
                'project': project,
                'findings': findings,
                'severity_counts': severity_counts,
                'score': score
            })
            
            all_findings.extend(findings)
            print(f"✅ {len(findings)} findings")
            
        except Exception as e:
            print(f"❌ Error: {str(e)}")
            project_results.append({
                'project': project,
                'error': str(e)
            })
    
    # Calculate overall statistics
    total_findings = len(all_findings)
    overall_severity = aggregate_findings_by_severity(all_findings)
    overall_score = calculate_security_score(all_findings)
    
    # Display summary
    print(f"\n{'='*60}")
    print(f"Total Findings: {total_findings}")
    print(f"\nBy Severity:")
    print(f"  🔴 CRITICAL: {overall_severity['CRITICAL']} findings")
    print(f"  🟠 HIGH: {overall_severity['HIGH']} findings")
    print(f"  🟡 MEDIUM: {overall_severity['MEDIUM']} findings")
    print(f"  🟢 LOW: {overall_severity['LOW']} findings")
    
    print(f"\n{'='*60}")
    print(f"By Project:\n")
    
    for result in project_results:
        if 'error' in result:
            print(f"  ❌ {result['project']['name']} (ID: {result['project']['id']})")
            print(f"     Error: {result['error']}\n")
        else:
            counts = result['severity_counts']
            print(f"  📁 {result['project']['name']} (ID: {result['project']['id']})")
            print(f"     CRITICAL: {counts['CRITICAL']}, HIGH: {counts['HIGH']}, MEDIUM: {counts['MEDIUM']}, LOW: {counts['LOW']}")
            print(f"     Score: {result['score']}/100\n")
    
    print(f"{'='*60}")
    print(f"Overall Security Score: {overall_score}/100")
    
    if overall_score >= 90:
        status = "✅ EXCELLENT"
    elif overall_score >= 75:
        status = "✓ GOOD"
    elif overall_score >= 50:
        status = "⚠️  NEEDS ATTENTION"
    else:
        status = "🔴 CRITICAL"
    
    print(f"Status: {status}\n")
    
    # Recommendations
    if overall_severity['CRITICAL'] > 0:
        print(f"⚠️  Recommendations:")
        print(f"  - Address {overall_severity['CRITICAL']} CRITICAL findings immediately")
    if overall_severity['HIGH'] > 0:
        print(f"  - Remediate {overall_severity['HIGH']} HIGH severity findings")
    if overall_severity['MEDIUM'] > 5:
        print(f"  - Review MEDIUM findings for quick wins")
    
    # Save detailed report
    report_data = {
        'generated': datetime.now().isoformat(),
        'projects_scanned': len(projects),
        'total_findings': total_findings,
        'overall_severity': overall_severity,
        'overall_score': overall_score,
        'project_results': [
            {
                'project_id': r['project']['id'],
                'project_name': r['project']['name'],
                'findings_count': len(r.get('findings', [])),
                'severity_counts': r.get('severity_counts', {}),
                'score': r.get('score', 0),
                'error': r.get('error')
            }
            for r in project_results
        ]
    }
    
    temp_dir = Path(__file__).parent / 'temp'
    temp_dir.mkdir(exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    report_file = temp_dir / f'posture-report-{timestamp}.json'
    
    with open(report_file, 'w') as f:
        json.dump(report_data, f, indent=2)
    
    print(f"\n📄 Detailed report saved: {report_file}\n")


if __name__ == "__main__":
    generate_consolidated_report()
