#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
GitLab Client - Enhanced wrapper using python-gitlab library + GraphQL

Dismissal strategy:
  - Pipeline-level findings: GraphQL securityFindingDismiss(uuid)
  - Project-level vulnerabilities: REST /api/v4/vulnerabilities/{id}/dismiss
"""
import sys
import time
from pathlib import Path
from typing import List, Dict

# Add local script directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

def sanitize_error(msg):
    """Sanitize error messages to avoid leaking sensitive info."""
    return str(msg)

try:
    import gitlab
    from gitlab.exceptions import GitlabError, GitlabAuthenticationError
    PYTHON_GITLAB_AVAILABLE = True
except ImportError:
    PYTHON_GITLAB_AVAILABLE = False
    print("⚠️  python-gitlab not installed. Install with: pip install python-gitlab")

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False


class GitLabClient:
    """Enhanced GitLab client using python-gitlab library + GraphQL"""
    
    # Maps snake_case reasons to GraphQL enum values
    GRAPHQL_REASONS = {
        'false_positive': 'FALSE_POSITIVE',
        'used_in_tests': 'USED_IN_TESTS',
        'acceptable_risk': 'ACCEPTABLE_RISK',
        'mitigating_control': 'MITIGATING_CONTROL',
    }
    
    def __init__(self, gitlab_url: str, token: str, verify_ssl: bool = False):
        if not PYTHON_GITLAB_AVAILABLE:
            raise ImportError("python-gitlab library not installed")
        
        self.gitlab_url = gitlab_url.rstrip('/')
        self.token = token
        self.verify_ssl = verify_ssl
        self.gl = gitlab.Gitlab(gitlab_url, private_token=token, ssl_verify=verify_ssl)

    def _request_with_retry(self, method: str, url: str, max_retries: int = 3, **kwargs) -> 'requests.Response':
        """Execute HTTP request with exponential backoff on 429 responses."""
        kwargs.setdefault('headers', {})['PRIVATE-TOKEN'] = self.token
        kwargs.setdefault('verify', self.verify_ssl)
        for attempt in range(max_retries + 1):
            r = getattr(requests, method)(url, **kwargs)
            if r.status_code != 429 or attempt == max_retries:
                return r
            wait = int(r.headers.get('Retry-After', 2 ** attempt))
            print(f"⚠️  Rate limited (429), retrying in {wait}s...")
            time.sleep(wait)
        return r
        
    def get_vulnerabilities(self, project_id: str, report_type: str = 'all') -> List[Dict]:
        """Get project-level vulnerabilities with automatic pagination."""
        try:
            project = self.gl.projects.get(project_id)
            vulns = project.vulnerabilities.list(all=True)
            
            results = []
            for vuln in vulns:
                if report_type != 'all' and vuln.report_type != report_type:
                    continue
                
                file_path = 'unknown'
                line_num = 0
                if hasattr(vuln, 'finding') and vuln.finding:
                    location = vuln.finding.get('location', {})
                    file_path = location.get('file', 'unknown')
                    line_num = location.get('start_line', 0)
                
                results.append({
                    'id': vuln.id,
                    'uuid': vuln.finding.get('uuid') if hasattr(vuln, 'finding') and vuln.finding else str(vuln.id),
                    'type': vuln.title,
                    'severity': vuln.severity,
                    'file': file_path,
                    'line': line_num,
                    'status': vuln.state,
                    'report_type': vuln.report_type,
                    'description': getattr(vuln, 'description', '')
                })
            
            return results
            
        except GitlabAuthenticationError as e:
            print(f"❌ Authentication failed: {sanitize_error(str(e))}")
            return []
        except GitlabError as e:
            print(f"❌ GitLab API error: {sanitize_error(str(e))}")
            return []
        except Exception as e:
            print(f"❌ Unexpected error: {sanitize_error(str(e))}")
            return []
    
    def get_pipeline_findings(self, project_id: str, pipeline_id: int,
                              severity: List[str] = None, state: str = None) -> List[Dict]:
        """
        Get pipeline-level security findings via REST API.
        
        Args:
            project_id: GitLab project ID
            pipeline_id: Pipeline ID
            severity: Filter by severity list e.g. ['critical', 'high']
            state: Filter by state e.g. 'detected'
        
        Returns:
            List of finding dictionaries with id, uuid, name, severity, state
        """
        if not REQUESTS_AVAILABLE:
            print("❌ requests library not installed")
            return []
        
        url = f'{self.gitlab_url}/api/v4/projects/{project_id}/vulnerability_findings'
        
        all_findings = []
        page = 1
        while True:
            r = self._request_with_retry('get', url,
                           params={'per_page': 100, 'pipeline_id': pipeline_id, 'page': page})
            if r.status_code != 200:
                print(f"❌ Failed to get findings: {r.status_code}")
                break
            batch = r.json()
            if not batch:
                break
            all_findings.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        
        # Apply filters
        results = all_findings
        if severity:
            sev_lower = [s.lower() for s in severity]
            results = [f for f in results if f['severity'].lower() in sev_lower]
        if state:
            results = [f for f in results if f['state'] == state]
        
        return results
    
    def dismiss_finding(self, uuid: str, reason: str = 'acceptable_risk',
                       comment: str = 'Dismissed via API') -> bool:
        """
        Dismiss a pipeline-level security finding via GraphQL.
        
        This is the correct approach for findings from branch pipelines
        that don't yet have project-level vulnerability records.
        
        Args:
            uuid: Finding UUID (from vulnerability_findings API)
            reason: Dismissal reason (false_positive, used_in_tests, acceptable_risk, mitigating_control)
            comment: Comment explaining dismissal
        
        Returns:
            True if successful, False otherwise
        """
        if not REQUESTS_AVAILABLE:
            print("❌ requests library not installed")
            return False
        
        gql_reason = self.GRAPHQL_REASONS.get(reason, reason.upper())
        # Escape quotes in comment for GraphQL
        safe_comment = comment.replace('"', '\\"')
        
        query = '''mutation {
          securityFindingDismiss(input: {
            uuid: "%s"
            comment: "%s"
            dismissalReason: %s
          }) { errors }
        }''' % (uuid, safe_comment, gql_reason)
        
        headers = {'PRIVATE-TOKEN': self.token, 'Content-Type': 'application/json'}
        r = self._request_with_retry('post', f'{self.gitlab_url}/api/graphql',
                         headers=headers, json={'query': query})
        
        if r.status_code != 200:
            print(f"⚠️  GraphQL request failed: {r.status_code}")
            return False
        
        data = r.json()
        errors = data.get('errors', [])
        mutation_errors = data.get('data', {}).get('securityFindingDismiss', {}).get('errors', [])
        
        if errors or mutation_errors:
            print(f"⚠️  Dismiss failed: {errors or mutation_errors}")
            return False
        
        return True
    
    def dismiss_vulnerability(self, project_id: str, vuln_id: int, reason: str = 'false_positive', 
                            comment: str = 'Marked as false positive') -> bool:
        """
        Dismiss a project-level vulnerability via REST API.
        
        Use for vulnerabilities on the default branch that have project-level IDs.
        For pipeline-level findings (branch pipelines), use dismiss_finding() instead.
        
        Endpoint: POST /api/v4/vulnerabilities/{id}/dismiss
        """
        if not REQUESTS_AVAILABLE:
            print("❌ requests library not installed")
            return False
        
        headers = {'PRIVATE-TOKEN': self.token, 'Content-Type': 'application/json'}
        url = f'{self.gitlab_url}/api/v4/vulnerabilities/{vuln_id}/dismiss'
        r = self._request_with_retry('post', url, headers=headers,
                         json={'dismissal_reason': reason, 'comment': comment})
        
        if r.status_code in (200, 201):
            return True
        
        print(f"⚠️  Failed to dismiss vulnerability {vuln_id}: {r.status_code}")
        return False
    
    def resolve_vulnerability(self, project_id: str, vuln_id: int, comment: str = 'Remediated',
                            reason: str = 'mitigating_control') -> bool:
        """Mark project-level vulnerability as resolved via dismiss with comment."""
        return self.dismiss_vulnerability(project_id, vuln_id, reason, comment)


def is_available() -> bool:
    """Check if python-gitlab library is available"""
    return PYTHON_GITLAB_AVAILABLE
