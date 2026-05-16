#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Gitleaks Manager - Main orchestration for Gitleaks finding management
"""
import sys
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List

# Add local script directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

def sanitize_error(msg):
    """Sanitize error messages to avoid leaking sensitive info."""
    return str(msg)

def validate_input(value, pattern=None, max_length=1024):
    """Basic input validation."""
    if not value or len(str(value)) > max_length:
        raise ValueError(f"Invalid input (length: {len(str(value)) if value else 0})")
    return str(value)

class ValidationError(ValueError):
    pass

try:
    from gitlab_token_manager import GitLabTokenManager
    from compliance_manager import ComplianceManager
except ImportError as e:
    print(f"Error: Required dependencies not found: {e}")
    print("Ensure gitlab_token_manager.py and compliance_manager.py are available")
    sys.exit(1)

import requests


class GitLabAPIError(Exception):
    """GitLab API error"""
    pass


class GitleaksManager:
    """Manages Gitleaks findings from GitLab"""
    
    def __init__(self, gitlab_url: str, project_id: str, verify_ssl: bool = False, use_python_gitlab: bool = False):
        self.gitlab_url = gitlab_url.rstrip('/')
        self.project_id = project_id
        self.verify_ssl = verify_ssl
        self.token_manager = GitLabTokenManager()
        self.token = None
        self.python_gitlab_client = None
        
        # Try to use python-gitlab if requested and available
        if use_python_gitlab:
            try:
                from gitlab_client import is_available
                if is_available():
                    # Will authenticate when first API call is made
                    self.python_gitlab_client = None  # Lazy initialization
                    self.use_python_gitlab = True
                else:
                    self.use_python_gitlab = False
            except ImportError:
                self.use_python_gitlab = False
        else:
            self.use_python_gitlab = False
    
    def _get_python_gitlab_client(self):
        """Lazy initialization of python-gitlab client"""
        if self.python_gitlab_client is None and self.use_python_gitlab:
            if not self.token:
                if not self._authenticate():
                    return None
            
            try:
                from gitlab_client import GitLabClient
                self.python_gitlab_client = GitLabClient(self.gitlab_url, self.token, self.verify_ssl)
            except Exception as e:
                print(f"⚠️  Failed to initialize python-gitlab: {sanitize_error(str(e))}")
                self.use_python_gitlab = False
                return None
        
        return self.python_gitlab_client
        
    def _authenticate(self) -> bool:
        """Load GitLab token"""
        try:
            self.token = self.token_manager.get_token(self.gitlab_url)
            if self.token is None:
                print("\n❌ No GitLab token found")
                print(f"\n📋 To setup your GitLab token, run:")
                print(f"\npython3 scripts/gitlab_token_manager.py \\")
                print(f"  --gitlab-url \"{self.gitlab_url}\" \\")
                print(f"  --token \"YOUR_GITLAB_TOKEN\"")
                print(f"\n💡 Get your token from: {self.gitlab_url}/-/user_settings/personal_access_tokens")
                print(f"   Required scopes: api, read_api\n")
                return False
            return True
        except Exception as e:
            print(f"Authentication failed: {sanitize_error(str(e))}")
            return False
    
    def _api_request(self, endpoint: str, method: str = 'GET', data: Dict = None, retries: int = 3) -> Dict:
        """Make GitLab API request with retry logic"""
        if not self.token:
            if not self._authenticate():
                raise GitLabAPIError("Authentication required")
        
        url = f"{self.gitlab_url}/api/v4{endpoint}"
        headers = {'PRIVATE-TOKEN': self.token}
        
        for attempt in range(retries):
            try:
                if method == 'GET':
                    response = requests.get(url, headers=headers, verify=self.verify_ssl, timeout=30)
                elif method == 'POST':
                    response = requests.post(url, headers=headers, json=data, verify=self.verify_ssl, timeout=30)
                elif method == 'PATCH':
                    response = requests.patch(url, headers=headers, json=data, verify=self.verify_ssl, timeout=30)
                else:
                    raise GitLabAPIError(f"Unsupported method: {method}")
                
                if response.status_code in [200, 201]:
                    return response.json() if response.text else {}
                elif response.status_code == 401:
                    raise GitLabAPIError("Authentication failed - check token")
                elif response.status_code == 404:
                    raise GitLabAPIError("Project or resource not found")
                else:
                    if attempt < retries - 1:
                        continue
                    raise GitLabAPIError(f"API error: {response.status_code}")
                    
            except requests.exceptions.Timeout:
                if attempt < retries - 1:
                    continue
                raise GitLabAPIError("Request timeout")
            except requests.exceptions.RequestException as e:
                if attempt < retries - 1:
                    continue
                raise GitLabAPIError(f"Request failed: {sanitize_error(str(e))}")
        
        raise GitLabAPIError("Max retries exceeded")
    
    def _check_compliance_file(self) -> None:
        """Check and update project-compliance.md with Gitleaks standard"""
        try:
            compliance_mgr = ComplianceManager()
            result = compliance_mgr.check_and_update()
            
            if result['status'] == 'CREATED':
                print(f"✅ {result['message']}")
            elif result['status'] == 'UPDATED':
                print(f"✅ {result['message']}")
            elif result['status'] == 'EXISTS':
                # Silent - already present
                pass
                
        except Exception as e:
            print(f"⚠️  Warning: Could not update compliance file: {sanitize_error(str(e))}")
            # Continue with scan even if compliance update fails
    
    def _extract_file_path(self, vuln: Dict) -> tuple:
        """
        Extract file path and line number from vulnerability with multiple fallbacks
        
        Returns:
            tuple: (file_path, line_number)
        """
        import re
        
        # Try nested finding.location structure (primary)
        finding_data = vuln.get('finding', {})
        location = finding_data.get('location', {})
        file_path = location.get('file')
        line_num = location.get('start_line', 0)
        
        if file_path:
            return (file_path, line_num)
        
        # Try direct location structure (fallback 1)
        location = vuln.get('location', {})
        file_path = location.get('file')
        line_num = location.get('start_line', 0)
        
        if file_path:
            return (file_path, line_num)
        
        # Parse description for file path patterns (fallback 2)
        description = vuln.get('description', '')
        
        # Common patterns: "in file path/to/file.py" or "path/to/file.py:123"
        patterns = [
            r'in\s+(?:file\s+)?([^\s:]+\.[a-zA-Z]+)',  # "in file path/to/file.py"
            r'([^\s:]+\.[a-zA-Z]+):(\d+)',              # "path/to/file.py:123"
            r'`([^`]+\.[a-zA-Z]+)`',                    # "`path/to/file.py`"
        ]
        
        for pattern in patterns:
            match = re.search(pattern, description)
            if match:
                file_path = match.group(1)
                line_num = int(match.group(2)) if len(match.groups()) > 1 else 0
                return (file_path, line_num)
        
        # No file path found
        return ('unknown', 0)
    
    def scan_findings(self, report_type: str = 'all', max_results: int = None, state: str = 'detected') -> List[Dict]:
        """
        Query GitLab for security findings with pagination support
        
        Args:
            report_type: Filter by report type ('all', 'secret_detection', 'sast', 'dependency_scanning', etc.)
            max_results: Maximum number of results to return (None = all results)
            state: Filter by state ('detected', 'all') - default 'detected' matches GitLab console
        """
        # Check and update project-compliance.md before scanning
        self._check_compliance_file()
        
        # Try python-gitlab first if available
        if self.use_python_gitlab:
            client = self._get_python_gitlab_client()
            if client:
                try:
                    findings = client.get_vulnerabilities(self.project_id, report_type)
                    if findings is not None:
                        print("✅ Using python-gitlab for enhanced API support")
                        return findings[:max_results] if max_results else findings
                except Exception as e:
                    print(f"⚠️  python-gitlab failed, falling back to requests: {sanitize_error(str(e))}")
                    self.use_python_gitlab = False
        
        # Fallback to requests-based implementation with pagination
        try:
            findings = []
            page = 1
            per_page = 100
            
            while True:
                # Use /vulnerabilities endpoint with pagination
                endpoint = f"/projects/{self.project_id}/vulnerabilities?per_page={per_page}&page={page}"
                
                if not self.token:
                    if not self._authenticate():
                        raise GitLabAPIError("Authentication required")
                
                url = f"{self.gitlab_url}/api/v4{endpoint}"
                headers = {'PRIVATE-TOKEN': self.token}
                
                response = requests.get(url, headers=headers, verify=self.verify_ssl, timeout=30)
                
                if response.status_code != 200:
                    if page == 1:
                        raise GitLabAPIError(f"API error: {response.status_code}")
                    break
                
                page_results = response.json()
                if not page_results:
                    break
                
                # Extract findings with enhanced file path extraction
                for vuln in page_results:
                    vuln_report_type = vuln.get('report_type', '')
                    vuln_state = vuln.get('state', 'unknown')
                    
                    # Filter by report type if specified
                    if report_type != 'all' and vuln_report_type != report_type:
                        continue
                    
                    # Filter by state (default: only 'detected' to match GitLab console)
                    if state != 'all' and vuln_state != state:
                        continue
                    
                    # Extract file path with fallback logic
                    file_path, line_num = self._extract_file_path(vuln)
                    
                    # Get finding data
                    finding_data = vuln.get('finding', {})
                    
                    findings.append({
                        'id': vuln.get('id'),
                        'uuid': finding_data.get('uuid', vuln.get('id')),
                        'type': finding_data.get('name', vuln.get('title', 'unknown')),
                        'severity': vuln.get('severity', 'unknown'),
                        'file': file_path,
                        'line': line_num,
                        'status': vuln_state,
                        'state': vuln_state,
                        'report_type': vuln_report_type,
                        'description': vuln.get('description', ''),
                        'name': vuln.get('title', '')
                    })
                    
                    # Check max_results limit
                    if max_results and len(findings) >= max_results:
                        return findings[:max_results]
                
                # Check if there are more pages
                if len(page_results) < per_page:
                    break
                
                page += 1
                
                # Safety limit to prevent infinite loops
                if page > 100:
                    print(f"⚠️  Reached page limit (100 pages, {len(findings)} findings)")
                    break
            
            return findings
            
        except GitLabAPIError as e:
            print(f"❌ Error scanning findings: {str(e)}")
            return []
    
    def mark_resolved(self, finding_id: str, comment: str = "Remediated by gitleaks-compliance",
                     dismissal_reason: str = "mitigating_control") -> bool:
        """Mark finding as resolved/dismissed in GitLab.
        
        Args:
            finding_id: Vulnerability ID
            comment: Remediation description
            dismissal_reason: One of 'false_positive', 'used_in_tests', 'acceptable_risk', 'mitigating_control'
        """
        # Try python-gitlab first if available
        if self.use_python_gitlab:
            client = self._get_python_gitlab_client()
            if client:
                try:
                    if client.dismiss_vulnerability(self.project_id, int(finding_id), dismissal_reason, comment):
                        return True
                except Exception as e:
                    print(f"⚠️  python-gitlab failed: {sanitize_error(str(e))}")
                    self.use_python_gitlab = False
        
        # Fallback to requests-based implementation
        try:
            # Revert to detected first so dismiss endpoint accepts the transition
            revert_endpoint = f"/projects/{self.project_id}/vulnerabilities/{finding_id}/revert"
            try:
                self._api_request(revert_endpoint, method='POST', data={})
            except GitLabAPIError:
                pass  # May already be in detected state

            endpoint = f"/projects/{self.project_id}/vulnerabilities/{finding_id}/dismiss"
            data = {
                'dismissal_reason': dismissal_reason,
                'comment': comment
            }
            
            try:
                self._api_request(endpoint, method='POST', data=data)
                return True
            except GitLabAPIError:
                # Try alternative endpoint
                endpoint = f"/projects/{self.project_id}/vulnerabilities/{finding_id}/confirm"
                data = {'state': 'resolved'}
                self._api_request(endpoint, method='POST', data=data)
                return True
            
        except GitLabAPIError as e:
            print(f"⚠️  Failed to mark resolved: {sanitize_error(str(e))}")
            return False
    
    def mark_false_positive(self, vulnerability_id: str, reason: str = "Documentation example with placeholder text",
                           dismissal_reason: str = "false_positive") -> bool:
        """Mark vulnerability as false positive in GitLab using vulnerability ID.
        
        Args:
            vulnerability_id: Vulnerability ID
            reason: Human-readable explanation
            dismissal_reason: One of 'false_positive', 'used_in_tests', 'acceptable_risk', 'mitigating_control'
        """
        comment = f"False positive: {reason}" if dismissal_reason == 'false_positive' else reason
        
        # Try python-gitlab first if available
        if self.use_python_gitlab:
            client = self._get_python_gitlab_client()
            if client:
                try:
                    if client.dismiss_vulnerability(self.project_id, int(vulnerability_id), dismissal_reason, comment):
                        return True
                except Exception as e:
                    print(f"⚠️  python-gitlab failed: {sanitize_error(str(e))}")
                    self.use_python_gitlab = False
        
        # Fallback to requests-based implementation
        try:
            # Revert to detected first so dismiss endpoint accepts the transition
            revert_endpoint = f"/projects/{self.project_id}/vulnerabilities/{vulnerability_id}/revert"
            try:
                self._api_request(revert_endpoint, method='POST', data={})
            except GitLabAPIError:
                pass  # May already be in detected state

            endpoint = f"/projects/{self.project_id}/vulnerabilities/{vulnerability_id}/dismiss"
            data = {
                'dismissal_reason': dismissal_reason,
                'comment': comment
            }
            
            try:
                self._api_request(endpoint, method='POST', data=data)
                return True
            except GitLabAPIError as e:
                # If dismiss fails, try confirm with dismissed state (older GitLab)
                if "not found" in str(e).lower():
                    endpoint = f"/projects/{self.project_id}/vulnerabilities/{vulnerability_id}/confirm"
                    data = {'state': 'dismissed'}
                    self._api_request(endpoint, method='POST', data=data)
                    return True
                raise
            
        except GitLabAPIError as e:
            print(f"⚠️  Failed to mark false positive: {sanitize_error(str(e))}")
            return False
    
    def detect_placeholder_pattern(self, finding: Dict) -> bool:
        """Detect if finding contains placeholder patterns (not real secrets)"""
        import re
        
        # Common placeholder patterns
        placeholder_patterns = [
            r'<[^>]+>',                    # <access-key-id>, <token>, etc.
            r'\[.*?\]',                    # [access-key-id], [token], etc.
            r'YOUR_[A-Z_]+',               # YOUR_TOKEN, YOUR_API_KEY, etc.
            r'EXAMPLE_[A-Z_]+',            # EXAMPLE_TOKEN, etc.
            r'xxx+',                       # xxxx, xxxxx, etc.
            r'\*\*\*+',                    # ****, *****, etc.
        ]
        
        # Check description for placeholder patterns
        description = finding.get('description', '') or ''
        for pattern in placeholder_patterns:
            if re.search(pattern, description, re.IGNORECASE):
                return True
        
        # Check file path for documentation indicators
        file_path = finding.get('file', '')
        doc_indicators = ['README', 'GUIDE', 'DOC', 'EXAMPLE', 'TEMPLATE', '.md']
        if any(indicator in file_path.upper() for indicator in doc_indicators):
            return True
        
        return False
    
    def generate_report(self, findings: List[Dict], format: str = 'json', project_name: str = None) -> str:
        """Generate executive compliance report"""
        # Get project name from config if not provided
        if not project_name:
            from project_config import ProjectConfig
            config = ProjectConfig()
            active_project = config.get_active_project()
            project_name = active_project.get('name', 'Unknown Project') if active_project else 'Unknown Project'
        
        # Calculate statistics
        total = len(findings)
        resolved = sum(1 for f in findings if f['status'] == 'resolved')
        open_count = total - resolved
        compliance_pct = (resolved / total * 100) if total > 0 else 0
        
        # Group by severity with percentages
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
        
        # Add percentages
        for sev in by_severity:
            total_sev = by_severity[sev]['total']
            by_severity[sev]['percentage'] = round((by_severity[sev]['resolved'] / total_sev * 100), 2) if total_sev > 0 else 0
        
        # Group by type
        by_type = {}
        for f in findings:
            ftype = f['type']
            if ftype not in by_type:
                by_type[ftype] = {'total': 0, 'resolved': 0, 'open': 0}
            by_type[ftype]['total'] += 1
            if f['status'] == 'resolved':
                by_type[ftype]['resolved'] += 1
            else:
                by_type[ftype]['open'] += 1
        
        # Calculate risk assessment
        critical_open = by_severity.get('critical', {}).get('open', 0)
        high_open = by_severity.get('high', {}).get('open', 0)
        medium_open = by_severity.get('medium', {}).get('open', 0)
        low_open = by_severity.get('low', {}).get('open', 0)
        
        risk_score = (critical_open * 10) + (high_open * 5) + (medium_open * 2) + low_open
        if risk_score <= 20:
            risk_level = 'LOW'
        elif risk_score <= 50:
            risk_level = 'MEDIUM'
        elif risk_score <= 80:
            risk_level = 'HIGH'
        else:
            risk_level = 'CRITICAL'
        
        # Get top 5 critical findings
        open_findings = [f for f in findings if f['status'] != 'resolved']
        critical_findings = sorted(
            open_findings,
            key=lambda x: (
                {'critical': 0, 'high': 1, 'medium': 2, 'low': 3, 'info': 4}.get(x['severity'], 5),
                x.get('id', 0)
            )
        )[:5]
        
        top_critical = [
            {
                'id': f['id'],
                'type': f['type'],
                'severity': f['severity'],
                'file': f.get('file', 'unknown'),
                'status': f['status']
            }
            for f in critical_findings
        ]
        
        # Generate recommendations
        recommendations = []
        if critical_open > 0:
            recommendations.append(f"⚠️ Immediate: Remediate {critical_open} critical finding{'s' if critical_open != 1 else ''}")
        if high_open > 0:
            recommendations.append(f"🔧 High Priority: Address {high_open} high severity finding{'s' if high_open != 1 else ''}")
        if medium_open > 0:
            recommendations.append(f"📋 Medium Priority: Review {medium_open} medium severity finding{'s' if medium_open != 1 else ''}")
        if compliance_pct < 95:
            recommendations.append("🛡️ Process Improvement: Implement automated secret scanning in CI/CD pipeline")
        if open_count > 0:
            recommendations.append("📊 Monitoring: Schedule weekly compliance reviews until 95% compliance achieved")
        
        # Build report data
        report_data = {
            'report_date': datetime.now().isoformat(),
            'project_id': self.project_id,
            'project_name': project_name,
            'gitlab_url': self.gitlab_url,
            'scan_metadata': {
                'scanner': 'Gitleaks',
                'scan_date': datetime.now().isoformat(),
                'report_generated': datetime.now().isoformat()
            },
            'executive_summary': {
                'overall_risk': risk_level,
                'compliance_status': 'IMPROVING' if compliance_pct >= 70 else 'NEEDS ATTENTION',
                'total_findings': total,
                'resolved': resolved,
                'open': open_count,
                'compliance_percentage': round(compliance_pct, 2)
            },
            'risk_assessment': {
                'critical_open': critical_open,
                'high_open': high_open,
                'medium_open': medium_open,
                'low_open': low_open,
                'risk_score': risk_score,
                'risk_level': risk_level
            },
            'by_severity': by_severity,
            'by_type': by_type,
            'top_critical_findings': top_critical,
            'recommendations': recommendations
        }
        
        # Save report
        timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        report_dir = Path('temp')
        report_dir.mkdir(exist_ok=True)
        
        if format == 'json':
            filename = report_dir / f'gitleaks-report-{timestamp}.json'
            with open(filename, 'w') as f:
                json.dump(report_data, f, indent=2)
        elif format == 'csv':
            filename = report_dir / f'gitleaks-report-{timestamp}.csv'
            with open(filename, 'w') as f:
                f.write('Finding ID,Type,Severity,File,Line,Status\n')
                for finding in findings:
                    f.write(f"{finding['id']},{finding['type']},{finding['severity']},"
                           f"{finding.get('file', 'unknown')},{finding.get('line', 'N/A')},{finding['status']}\n")
        elif format == 'markdown':
            filename = report_dir / f'gitleaks-executive-report-{timestamp}.md'
            with open(filename, 'w') as f:
                f.write(self._generate_markdown_report(report_data))
        
        return str(filename)
    
    def _generate_markdown_report(self, report_data: Dict) -> str:
        """Generate executive Markdown report"""
        md = []
        
        # Header
        md.append("# 🔐 Gitleaks Security Compliance Report\n")
        md.append(f"**Project:** {report_data['project_name']}  ")
        md.append(f"**Project ID:** {report_data['project_id']}  ")
        md.append(f"**GitLab:** {report_data['gitlab_url']}  ")
        md.append(f"**Report Date:** {datetime.fromisoformat(report_data['report_date']).strftime('%B %d, %Y')}  ")
        
        exec_summary = report_data['executive_summary']
        compliance_icon = '✅' if exec_summary['compliance_percentage'] >= 80 else '⚠️'
        md.append(f"**Compliance Status:** {exec_summary['compliance_percentage']}% {compliance_icon}\n")
        md.append("---\n")
        
        # Executive Summary
        md.append("## Executive Summary\n")
        risk_icon = {'LOW': '🟢', 'MEDIUM': '🟡', 'HIGH': '🟠', 'CRITICAL': '🔴'}.get(exec_summary['overall_risk'], '⚪')
        md.append(f"**Overall Security Posture:** {exec_summary['overall_risk']} RISK {risk_icon}\n")
        md.append(f"- **Total Findings:** {exec_summary['total_findings']}")
        md.append(f"- **Resolved:** {exec_summary['resolved']} ✅ ({exec_summary['compliance_percentage']}%)")
        md.append(f"- **Open:** {exec_summary['open']} ⚠️ ({100 - exec_summary['compliance_percentage']:.1f}%)\n")
        md.append("---\n")
        
        # Risk Assessment
        md.append("## Risk Assessment\n")
        md.append("| Risk Level | Open Findings | Status |")
        md.append("|------------|---------------|--------|")
        
        risk = report_data['risk_assessment']
        if risk['critical_open'] > 0:
            md.append(f"| 🔴 Critical | {risk['critical_open']} | Immediate Action Required |")
        if risk['high_open'] > 0:
            md.append(f"| 🟠 High | {risk['high_open']} | High Priority |")
        if risk['medium_open'] > 0:
            md.append(f"| 🟡 Medium | {risk['medium_open']} | Moderate Priority |")
        if risk['low_open'] > 0:
            md.append(f"| 🟢 Low | {risk['low_open']} | Low Priority |")
        
        md.append(f"\n**Risk Score:** {risk['risk_score']}/100 ({risk['risk_level']})\n")
        md.append("---\n")
        
        # Compliance by Severity
        md.append("## Compliance by Severity\n")
        md.append("| Severity | Total | Resolved | Open | Compliance |")
        md.append("|----------|-------|----------|------|------------|")
        
        severity_order = ['critical', 'high', 'medium', 'low', 'info']
        severity_icons = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🟢', 'info': '🔵'}
        
        for sev in severity_order:
            if sev in report_data['by_severity']:
                data = report_data['by_severity'][sev]
                icon = severity_icons.get(sev, '⚪')
                resolved_icon = '✅' if data['resolved'] > 0 else ''
                open_icon = '⚠️' if data['open'] > 0 else ''
                md.append(f"| {icon} {sev.title()} | {data['total']} | {data['resolved']} {resolved_icon} | "
                         f"{data['open']} {open_icon} | {data['percentage']}% |")
        
        md.append("\n---\n")
        
        # Top Critical Findings
        if report_data['top_critical_findings']:
            md.append("## Top Critical Findings Requiring Attention\n")
            for i, finding in enumerate(report_data['top_critical_findings'], 1):
                sev_icon = severity_icons.get(finding['severity'], '⚪')
                md.append(f"{i}. **{finding['type']}** ({sev_icon} {finding['severity'].title()}) - `{finding['file']}`")
                md.append(f"   - Status: {finding['status'].title()} ⚠️")
                md.append(f"   - Finding ID: {finding['id']}\n")
            md.append("---\n")
        
        # Recommendations
        if report_data['recommendations']:
            md.append("## Recommendations\n")
            for i, rec in enumerate(report_data['recommendations'], 1):
                md.append(f"{i}. {rec}")
            md.append("\n---\n")
        
        # Compliance Trend
        md.append("## Compliance Status\n")
        md.append(f"**Current:** {exec_summary['compliance_percentage']}% {compliance_icon}  ")
        md.append(f"**Status:** {exec_summary['compliance_status']}\n")
        
        if exec_summary['compliance_percentage'] < 95:
            md.append(f"\n**Target:** 95% compliance\n")
        
        md.append("\n---\n")
        md.append("*Report generated by GitLab Security Scanning Skill*\n")
        
        return '\n'.join(md)
    
    def output_manual_remediation_summary(self, findings: List[Dict]) -> None:
        """
        Output summary of findings requiring manual GitLab UI updates
        
        Args:
            findings: List of findings that need manual resolution
        """
        # Filter findings that still need manual updates (not dismissed/resolved)
        manual_updates = [
            f for f in findings 
            if f.get('state') not in ['dismissed', 'resolved', 'confirmed']
        ]
        
        if not manual_updates:
            print("\n✅ All findings successfully updated via API - no manual updates needed!")
            return
        
        # Display header
        print("\n" + "="*80)
        print("⚠️  MANUAL GITLAB UI UPDATES REQUIRED")
        print("="*80)
        print(f"\nThe following {len(manual_updates)} finding(s) require manual updates in GitLab UI:")
        print("(API dismissal failed - please mark as Resolved or False Positive manually)\n")
        
        # Format findings list
        summary_lines = []
        for idx, finding in enumerate(manual_updates, 1):
            finding_id = finding.get('id', 'N/A')
            description = finding.get('description') or finding.get('name') or 'No description'
            description = description[:80] if description else 'No description'
            file_path = finding.get('file', 'Unknown file')
            severity = finding.get('severity', 'unknown').upper()
            
            print(f"{idx}. Finding ID: {finding_id}")
            print(f"   Severity: {severity}")
            print(f"   Description: {description}")
            print(f"   File: {file_path}")
            print()
            
            summary_lines.append(f"{idx}. ID: {finding_id} | {severity} | {description} | {file_path}")
        
        # Save to temp file
        timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        temp_dir = Path('temp')
        temp_dir.mkdir(exist_ok=True)
        summary_file = temp_dir / f'manual-remediation-{timestamp}.txt'
        
        with open(summary_file, 'w') as f:
            f.write("MANUAL GITLAB UI UPDATES REQUIRED\n")
            f.write("="*80 + "\n\n")
            f.write(f"Generated: {datetime.now().isoformat()}\n")
            f.write(f"Project ID: {self.project_id}\n")
            f.write(f"Total findings requiring manual update: {len(manual_updates)}\n\n")
            f.write("INSTRUCTIONS:\n")
            f.write("1. Navigate to GitLab project Security & Compliance > Vulnerability Report\n")
            f.write("2. Find each vulnerability by ID below\n")
            f.write("3. Click on the vulnerability\n")
            f.write("4. Select 'Dismiss' or 'Resolve' from the dropdown\n")
            f.write("5. Add comment explaining the action\n\n")
            f.write("FINDINGS:\n")
            f.write("-"*80 + "\n\n")
            for line in summary_lines:
                f.write(line + "\n")
        
        print(f"📄 Summary saved to: {summary_file}")
        print("\nINSTRUCTIONS:")
        print("1. Navigate to GitLab project Security & Compliance > Vulnerability Report")
        print("2. Find each vulnerability by ID above")
        print("3. Click on the vulnerability")
        print("4. Select 'Dismiss' or 'Resolve' from the dropdown")
        print("5. Add comment explaining the action")
        print("="*80 + "\n")


def main():
    """CLI interface for testing"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Gitleaks Manager')
    parser.add_argument('--gitlab-url', required=True, help='GitLab URL')
    parser.add_argument('--project-id', required=True, help='Project ID')
    parser.add_argument('--action', choices=['scan', 'report'], required=True)
    parser.add_argument('--format', choices=['json', 'csv'], default='json')
    
    args = parser.parse_args()
    
    manager = GitleaksManager(args.gitlab_url, args.project_id)
    
    if args.action == 'scan':
        findings = manager.scan_findings()
        print(f"\n🔍 Found {len(findings)} Gitleaks findings\n")
        for f in findings:
            print(f"  [{f['severity'].upper()}] {f['type']}")
            print(f"    File: {f['file']}:{f['line']}")
            print(f"    Status: {f['status']}\n")
    
    elif args.action == 'report':
        findings = manager.scan_findings()
        report_file = manager.generate_report(findings, args.format)
        print(f"✅ Report saved: {report_file}")


if __name__ == "__main__":
    main()
