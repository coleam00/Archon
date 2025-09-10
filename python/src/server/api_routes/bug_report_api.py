"""
Bug Report API for Archon Beta

Handles bug report submission to GitHub Issues with automatic context formatting.
"""

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config.logfire_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/bug-report", tags=["bug-report"])


class BugContext(BaseModel):
    error: dict[str, Any]
    app: dict[str, Any]
    system: dict[str, Any]
    services: dict[str, bool]
    logs: list[str]


class BugReportRequest(BaseModel):
    title: str
    description: str
    stepsToReproduce: str
    expectedBehavior: str
    actualBehavior: str
    severity: str
    component: str
    context: BugContext


class BugReportResponse(BaseModel):
    success: bool
    issue_number: int | None = None
    issue_url: str | None = None
    message: str


class GitHubService:
    def __init__(self):
        self.token = os.getenv("GITHUB_TOKEN")
        self.repo = os.getenv("GITHUB_REPO", "dynamous-community/Archon-V2-Alpha")

    async def create_issue(self, bug_report: BugReportRequest) -> dict[str, Any]:
        """Create a GitHub issue from a bug report."""

        if not self.token:
            raise HTTPException(
                status_code=500, detail="GitHub integration not configured - GITHUB_TOKEN not found"
            )

        # Format the issue body
        issue_body = self._format_issue_body(bug_report)

        issue_data = {
            "title": bug_report.title,
            "body": issue_body,
            "labels": [
                "bug",
                "auto-report",
                f"severity:{bug_report.severity}",
                f"component:{bug_report.component}",
            ],
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"https://api.github.com/repos/{self.repo}/issues",
                    headers={
                        "Authorization": f"Bearer {self.token}",
                        "Accept": "application/vnd.github.v3+json",
                        "User-Agent": "Archon-Bug-Reporter/1.0",
                    },
                    json=issue_data,
                )

                if response.status_code == 201:
                    issue_data = response.json()
                    return {
                        "success": True,
                        "issue_number": issue_data["number"],
                        "issue_url": issue_data["html_url"],
                    }
                elif response.status_code == 401:
                    logger.error("GitHub API authentication failed")
                    raise HTTPException(
                        status_code=500,
                        detail="GitHub authentication failed - check GITHUB_TOKEN permissions",
                    )
                else:
                    logger.error(f"GitHub API error: {response.status_code} - {response.text}")
                    raise HTTPException(
                        status_code=500, detail=f"GitHub API error: {response.status_code}"
                    )

        except httpx.TimeoutException:
            logger.error("GitHub API request timed out")
            raise HTTPException(status_code=500, detail="GitHub API request timed out")
        except Exception as e:
            logger.error(f"Unexpected error creating GitHub issue: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to create GitHub issue: {str(e)}")

    def _format_issue_body(self, bug_report: BugReportRequest) -> str:
        """Format the bug report as a GitHub issue body."""

        # Map severity to emoji
        severity_map = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}

        # Map component to emoji
        component_map = {
            "knowledge-base": "🔍",
            "mcp-integration": "🔗",
            "projects-tasks": "📋",
            "settings": "⚙️",
            "ui": "🖥️",
            "infrastructure": "🐳",
            "not-sure": "❓",
        }

        severity_emoji = severity_map.get(bug_report.severity, "❓")
        component_emoji = component_map.get(bug_report.component, "❓")

        return f"""## {severity_emoji} Bug Report

**Reported by:** User (Archon Beta)
**Severity:** {severity_emoji} {bug_report.severity.title()}
**Component:** {component_emoji} {bug_report.component.replace("-", " ").title()}
**Version:** {bug_report.context.app.get("version", "unknown")}
**Platform:** {bug_report.context.system.get("platform", "unknown")}

### Description
{bug_report.description}

### Steps to Reproduce
{bug_report.stepsToReproduce or "Not specified"}

### Expected Behavior
{bug_report.expectedBehavior or "Not specified"}

### Actual Behavior
{bug_report.actualBehavior or "Not specified"}

---

## 🔧 Technical Context

### Error Details
```
Error: {bug_report.context.error.get("name", "Unknown")}
Message: {bug_report.context.error.get("message", "No message")}

Stack Trace:
{bug_report.context.error.get("stack", "No stack trace available")}
```

### System Information
- **Platform:** {bug_report.context.system.get("platform", "unknown")}
- **Version:** {bug_report.context.app.get("version", "unknown")}
- **URL:** {bug_report.context.app.get("url", "unknown")}
- **Timestamp:** {bug_report.context.app.get("timestamp", "unknown")}
- **Memory:** {bug_report.context.system.get("memory", "unknown")}

### Service Status
- **Server:** {"✅" if bug_report.context.services.get("server") else "❌"}
- **MCP:** {"✅" if bug_report.context.services.get("mcp") else "❌"}
- **Agents:** {"✅" if bug_report.context.services.get("agents") else "❌"}

### Recent Logs
```
{chr(10).join(bug_report.context.logs[-10:]) if bug_report.context.logs else "No logs available"}
```

---
*Auto-generated by Archon Bug Reporter*
"""


# Global GitHub service instance
github_service = GitHubService()


@router.post("/github", response_model=BugReportResponse)
async def create_github_issue(bug_report: BugReportRequest):
    """
    Create a GitHub issue from a bug report.

    For open source: If no GitHub token is configured, returns a pre-filled
    GitHub issue creation URL for the user to submit manually.

    For maintainers: If GitHub token exists, creates the issue directly via API.
    """

    logger.info(
        f"Processing bug report: {bug_report.title} (severity: {bug_report.severity}, component: {bug_report.component})"
    )

    # Check if we have GitHub token (maintainer mode)
    if github_service.token:
        try:
            result = await github_service.create_issue(bug_report)

            logger.info(
                f"Successfully created GitHub issue #{result['issue_number']}: {result['issue_url']}"
            )

            return BugReportResponse(
                success=True,
                issue_number=result["issue_number"],
                issue_url=result["issue_url"],
                message=f"Bug report created as issue #{result['issue_number']}",
            )

        except HTTPException:
            # If API fails, fall back to manual submission
            logger.warning("GitHub API failed, falling back to manual submission")
            return _create_manual_submission_response(bug_report)
        except Exception as e:
            logger.error(f"GitHub API error: {e}, falling back to manual submission")
            return _create_manual_submission_response(bug_report)

    # No token (open source user mode) - create manual submission URL
    else:
        logger.info("No GitHub token configured, creating manual submission URL")
        return _create_manual_submission_response(bug_report)


def _create_manual_submission_response(bug_report: BugReportRequest) -> BugReportResponse:
    """Create a response with pre-filled GitHub issue URL for manual submission."""

    # Format the issue body for URL encoding
    issue_body = github_service._format_issue_body(bug_report)

    # Create pre-filled GitHub issue URL
    import urllib.parse

    base_url = f"https://github.com/{github_service.repo}/issues/new"
    params = {
        "template": "bug_report.yml",
        "title": bug_report.title,
        "labels": f"bug,auto-report,severity:{bug_report.severity},component:{bug_report.component}",
    }

    # Add the formatted body as a parameter
    params["body"] = issue_body

    # Build the URL
    query_string = urllib.parse.urlencode(params)
    github_url = f"{base_url}?{query_string}"

    return BugReportResponse(
        success=True,
        issue_number=None,
        issue_url=github_url,
        message="Click the provided URL to submit your bug report to GitHub",
    )


@router.get("/health")
async def bug_report_health():
    """Health check for bug reporting service."""

    github_configured = bool(os.getenv("GITHUB_TOKEN"))
    repo_configured = bool(os.getenv("GITHUB_REPO"))

    return {
        "status": "healthy" if github_configured else "degraded",
        "github_token_configured": github_configured,
        "github_repo_configured": repo_configured,
        "repo": os.getenv("GITHUB_REPO", "dynamous-community/Archon-V2-Alpha"),
        "message": "Bug reporting is ready" if github_configured else "GitHub token not configured",
    }
