#!/usr/bin/env python3
"""
Multi-Agent Scenario Test for Archon.

Tests the shared memory system by simulating multiple agents:
- Agent 1 (Claude via MCP): Creates and reads tasks
- Agent 2 (User via UI/API): Updates tasks
- Documents pain points and coordination issues

Usage:
    uv run python scripts/test_multi_agent_scenario.py
"""

import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import httpx

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.server.config.logfire_config import get_logger

logger = get_logger(__name__)

MCP_BASE_URL = os.getenv("ARCHON_MCP_URL",    "http://localhost:8051")
API_BASE_URL = os.getenv("ARCHON_SERVER_URL", "http://localhost:8181")


class MultiAgentScenarioTest:
    """Test multi-agent coordination using Archon's shared memory."""

    def __init__(self):
        self.test_project_id = None
        self.test_task_id = None
        self.observations = []
        self.pain_points = []
        self.successes = []

    def log_observation(self, agent: str, action: str, result: str, details: dict = None):
        """Log an observation during the test."""
        observation = {
            "timestamp": datetime.now().isoformat(),
            "agent": agent,
            "action": action,
            "result": result,
            "details": details or {},
        }
        self.observations.append(observation)
        logger.info(f"[{agent}] {action}: {result}")

    def add_pain_point(self, description: str, severity: str = "medium"):
        """Record a pain point encountered."""
        self.pain_points.append({"description": description, "severity": severity})
        logger.warning(f"PAIN POINT: {description}")

    def add_success(self, description: str):
        """Record a successful interaction."""
        self.successes.append(description)
        logger.info(f"SUCCESS: {description}")

    async def call_mcp_tool(self, tool_name: str, params: dict) -> dict:
        """Call an MCP tool and return the result."""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{MCP_BASE_URL}/call_tool",
                    json={"name": tool_name, "arguments": params},
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "data": result}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def call_api(self, method: str, path: str, **kwargs) -> dict:
        """Call a REST API endpoint and return the result."""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                if method == "GET":
                    response = await client.get(f"{API_BASE_URL}{path}", **kwargs)
                elif method == "POST":
                    response = await client.post(f"{API_BASE_URL}{path}", **kwargs)
                elif method == "PUT":
                    response = await client.put(f"{API_BASE_URL}{path}", **kwargs)
                elif method == "DELETE":
                    response = await client.delete(f"{API_BASE_URL}{path}", **kwargs)

                response.raise_for_status()
                return {"success": True, "data": response.json()}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def setup_test_project(self):
        """Create a test project for the scenario."""
        logger.info("\n" + "=" * 60)
        logger.info("SETUP: Creating test project")
        logger.info("=" * 60)

        # Get existing projects first
        result = await self.call_api("GET", "/api/projects")
        if result["success"]:
            projects_data = result["data"]
            # Handle both list and dict responses
            if isinstance(projects_data, list):
                projects = projects_data
            else:
                projects = projects_data.get("projects", [])

            # Use first project or create one
            if projects:
                self.test_project_id = projects[0]["id"]
                self.log_observation(
                    "Setup",
                    "Use existing project",
                    "Found existing project",
                    {"project_id": self.test_project_id},
                )
            else:
                # Create new project
                create_result = await self.call_api(
                    "POST",
                    "/api/projects",
                    json={
                        "title": "Multi-Agent Test Project",
                        "description": "Test project for multi-agent coordination scenario",
                    },
                )
                if create_result["success"]:
                    self.test_project_id = create_result["data"]["project"]["id"]
                    self.log_observation(
                        "Setup",
                        "Create test project",
                        "Success",
                        {"project_id": self.test_project_id},
                    )

    async def agent1_create_task(self):
        """Agent 1 (Claude) creates a task via API (simulating MCP tool behavior)."""
        logger.info("\n" + "=" * 60)
        logger.info("STEP 1: Agent 1 (Claude) creates a task")
        logger.info("=" * 60)
        logger.info("NOTE: Using API directly (MCP server uses SSE protocol, not REST)")

        # Use API directly (MCP would use the same endpoints under the hood)
        result = await self.call_api(
            "POST",
            "/api/tasks",
            json={
                "project_id": self.test_project_id,
                "title": "Multi-Agent Test Task",
                "description": "This task was created by Agent 1 (Claude) to test shared memory coordination",
                "assignee": "claude",
                "priority": "medium",
                "task_order": 0,
            },
        )

        if result["success"]:
            task_data = result["data"]
            self.test_task_id = task_data["task"]["id"]
            self.log_observation(
                "Agent1-Claude",
                "Create task via API",
                "Success",
                {"task_id": self.test_task_id, "method": "POST /api/tasks"},
            )
            self.add_success("Agent 1 successfully created task")

            # Check what information is immediately available
            task_info = task_data.get("task", {})
            self.log_observation(
                "Agent1-Claude",
                "Check created task data",
                f"Received task with {len(task_info)} fields",
                {"fields": list(task_info.keys())},
            )
        else:
            self.add_pain_point(f"Failed to create task: {result['error']}", "high")

    async def agent2_update_task(self):
        """Agent 2 (User) updates the task via REST API (simulating UI)."""
        logger.info("\n" + "=" * 60)
        logger.info("STEP 2: Agent 2 (User via UI/API) updates the task")
        logger.info("=" * 60)

        result = await self.call_api(
            "PUT",
            f"/api/tasks/{self.test_task_id}",
            json={
                "status": "doing",
                "description": "This task was updated by Agent 2 (User via UI). The status changed from 'todo' to 'doing'.",
            },
        )

        if result["success"]:
            self.log_observation(
                "Agent2-User",
                "Update task via API",
                "Success",
                {"task_id": self.test_task_id, "changes": ["status", "description"]},
            )
            self.add_success("Agent 2 successfully updated task via REST API")

            # Note: Check if there's any notification or flag for other agents
            self.log_observation(
                "System",
                "Check coordination mechanism",
                "No push notification mechanism observed",
                {
                    "note": "Agent 1 must poll or explicitly check to see updates",
                    "coordination": "pull-based",
                },
            )
        else:
            self.add_pain_point(f"Failed to update task via API: {result['error']}", "high")

    async def agent1_read_updated_task(self):
        """Agent 1 (Claude) reads the task again to see updates."""
        logger.info("\n" + "=" * 60)
        logger.info("STEP 3: Agent 1 (Claude) reads the updated task")
        logger.info("=" * 60)

        result = await self.call_api("GET", f"/api/tasks/{self.test_task_id}")

        if result["success"]:
            task = result["data"]
            self.log_observation(
                "Agent1-Claude",
                "Read task via API",
                "Success",
                {
                    "task_id": self.test_task_id,
                    "status": task.get("status"),
                    "updated_at": task.get("updated_at"),
                },
            )

            # Verify Agent 1 can see Agent 2's changes
            if task.get("status") == "doing":
                self.add_success(
                    "Agent 1 can see Agent 2's status change (todo → doing)"
                )
            else:
                self.add_pain_point(
                    f"Agent 1 doesn't see status update. Got: {task.get('status')}",
                    "high",
                )

            if "Agent 2" in task.get("description", ""):
                self.add_success("Agent 1 can see Agent 2's description update")
            else:
                self.add_pain_point(
                    "Agent 1 doesn't see description update", "medium"
                )

            # Check timestamps
            if task.get("updated_at"):
                self.log_observation(
                    "Agent1-Claude",
                    "Check update tracking",
                    "Timestamp available",
                    {"updated_at": task["updated_at"]},
                )
                self.add_success("Update timestamps are tracked")
            else:
                self.add_pain_point("No update timestamp available", "medium")
        else:
            self.add_pain_point(
                f"Failed to read task: {result['error']}", "high"
            )

    async def test_context_sharing(self):
        """Test if agents can share context via sessions."""
        logger.info("\n" + "=" * 60)
        logger.info("STEP 4: Test context sharing via sessions")
        logger.info("=" * 60)

        # Agent 1 creates a session
        session_result = await self.call_api(
            "POST",
            "/api/sessions",
            json={
                "agent": "claude",
                "project_id": self.test_project_id,
                "context": {"working_on": self.test_task_id, "test_scenario": True},
            },
        )

        if session_result["success"]:
            session_data = session_result["data"]
            session_id = session_data["session"]["id"]
            self.log_observation(
                "Agent1-Claude",
                "Create session with context",
                "Success",
                {"session_id": session_id, "context_shared": True},
            )
            self.add_success("Agent can create session with context")

            # Agent 2 (or another agent) can read this session
            read_session = await self.call_api("GET", f"/api/sessions/{session_id}")

            if read_session["success"]:
                session = read_session["data"]["session"]
                context = session.get("context", {})

                if context.get("working_on") == self.test_task_id:
                    self.add_success(
                        "Other agents can read session context (explicit lookup required)"
                    )
                    self.log_observation(
                        "System",
                        "Context sharing mechanism",
                        "Pull-based: agents must explicitly query sessions",
                        {"context_keys": list(context.keys())},
                    )
                else:
                    self.add_pain_point(
                        "Context not properly shared in session", "medium"
                    )
            else:
                self.add_pain_point(
                    f"Failed to read session: {read_session['error']}", "medium"
                )
        else:
            self.add_pain_point(
                f"Failed to create session: {session_result['error']}", "medium"
            )

    async def cleanup(self):
        """Clean up test data."""
        logger.info("\n" + "=" * 60)
        logger.info("CLEANUP: Removing test task")
        logger.info("=" * 60)

        if self.test_task_id:
            result = await self.call_api("DELETE", f"/api/tasks/{self.test_task_id}")
            if result["success"]:
                logger.info("✓ Test task deleted")
            else:
                logger.warning(f"Failed to delete test task: {result.get('error')}")

    def generate_report(self) -> dict:
        """Generate a comprehensive test report."""
        return {
            "test_info": {
                "name": "Multi-Agent Coordination Scenario",
                "timestamp": datetime.now().isoformat(),
                "agents_tested": ["Agent1-Claude-MCP", "Agent2-User-API"],
            },
            "summary": {
                "total_observations": len(self.observations),
                "successes": len(self.successes),
                "pain_points": len(self.pain_points),
                "pain_points_by_severity": {
                    "high": len([p for p in self.pain_points if p["severity"] == "high"]),
                    "medium": len(
                        [p for p in self.pain_points if p["severity"] == "medium"]
                    ),
                    "low": len([p for p in self.pain_points if p["severity"] == "low"]),
                },
            },
            "observations": self.observations,
            "successes": self.successes,
            "pain_points": self.pain_points,
            "recommendations": self.generate_recommendations(),
        }

    def generate_recommendations(self) -> list[str]:
        """Generate recommendations based on test results."""
        recommendations = []

        # Analyze pain points
        has_high_severity = any(p["severity"] == "high" for p in self.pain_points)

        if has_high_severity:
            recommendations.append(
                "HIGH PRIORITY: Address critical coordination failures before production use"
            )

        # Check for notification issues
        if any("notification" in p["description"].lower() for p in self.pain_points):
            recommendations.append(
                "Consider implementing push notifications or webhooks for real-time updates"
            )

        # Check for context sharing issues
        if any("context" in p["description"].lower() for p in self.pain_points):
            recommendations.append(
                "Improve context sharing mechanisms - currently requires explicit session queries"
            )

        # Success patterns
        if len(self.successes) > len(self.pain_points):
            recommendations.append(
                "Core shared memory functionality works - focus on improving UX"
            )

        # General recommendation
        recommendations.append(
            "Document coordination patterns for multi-agent workflows"
        )
        recommendations.append(
            "Create helper functions for common coordination tasks (e.g., 'get_active_work_by_agent')"
        )

        return recommendations

    def print_report(self, report: dict):
        """Print a formatted test report."""
        print("\n" + "=" * 80)
        print("MULTI-AGENT SCENARIO TEST REPORT")
        print("=" * 80)

        print(f"\nTest: {report['test_info']['name']}")
        print(f"Timestamp: {report['test_info']['timestamp']}")
        print(f"Agents: {', '.join(report['test_info']['agents_tested'])}")

        print("\n" + "-" * 80)
        print("SUMMARY")
        print("-" * 80)
        print(f"Total Observations: {report['summary']['total_observations']}")
        print(f"Successes: {report['summary']['successes']}")
        print(f"Pain Points: {report['summary']['pain_points']}")
        print(
            f"  - High Severity: {report['summary']['pain_points_by_severity']['high']}"
        )
        print(
            f"  - Medium Severity: {report['summary']['pain_points_by_severity']['medium']}"
        )
        print(
            f"  - Low Severity: {report['summary']['pain_points_by_severity']['low']}"
        )

        print("\n" + "-" * 80)
        print("SUCCESSES")
        print("-" * 80)
        for i, success in enumerate(report["successes"], 1):
            print(f"{i}. ✓ {success}")

        print("\n" + "-" * 80)
        print("PAIN POINTS")
        print("-" * 80)
        for i, pain_point in enumerate(report["pain_points"], 1):
            severity_icon = "🔴" if pain_point["severity"] == "high" else "🟡"
            print(
                f"{i}. {severity_icon} [{pain_point['severity'].upper()}] {pain_point['description']}"
            )

        print("\n" + "-" * 80)
        print("RECOMMENDATIONS")
        print("-" * 80)
        for i, recommendation in enumerate(report["recommendations"], 1):
            print(f"{i}. {recommendation}")

        print("\n" + "=" * 80)

    def save_report(self, report: dict, output_file: str = "multi_agent_test_report.json"):
        """Save report to JSON file."""
        output_path = Path(__file__).parent.parent / "docs" / output_file
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w") as f:
            json.dump(report, f, indent=2)

        logger.info(f"\n✓ Report saved to {output_path}")
        return output_path


async def main():
    """Main entry point."""
    print("\n" + "=" * 80)
    print("MULTI-AGENT COORDINATION SCENARIO TEST")
    print("=" * 80)
    print("\nThis test simulates:")
    print("1. Agent 1 (Claude via MCP) creates a task")
    print("2. Agent 2 (User via UI/API) updates the task")
    print("3. Agent 1 reads the updated task")
    print("4. Both agents share context via sessions")
    print("\n" + "=" * 80)

    test = MultiAgentScenarioTest()

    try:
        # Run test scenario
        await test.setup_test_project()
        await test.agent1_create_task()

        if test.test_task_id:
            await test.agent2_update_task()
            await test.agent1_read_updated_task()
            await test.test_context_sharing()

            # Cleanup
            await test.cleanup()

        # Generate and display report
        report = test.generate_report()
        test.print_report(report)
        output_file = test.save_report(report)

        print(f"\n✓ Test complete! Report saved to {output_file}")

    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        await test.cleanup()
        sys.exit(1)
    except Exception as e:
        logger.error(f"Test failed: {e}", exc_info=True)
        print(f"\n\nERROR: {e}")
        await test.cleanup()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
