#!/usr/bin/env python3
"""
Populate Whiteboard with Test Data

Publishes test sessions and tasks to Redis to demonstrate the whiteboard functionality.
"""

import json
import os
import redis
from datetime import datetime, timezone

REDIS_URL = os.getenv("REDIS_URL", "redis://llm-streamer-redis:6379")

# Test data
TEST_SESSIONS = [
    {
        "session_id": "session-claude-001",
        "agent": "Claude Sonnet 4.5",
        "project_id": "6cc3ca3f-ad32-4cbf-98b3-975abbbddeee",
        "started_at": datetime.now(timezone.utc).isoformat()
    },
    {
        "session_id": "session-gemini-001",
        "agent": "Gemini Pro",
        "project_id": "6cc3ca3f-ad32-4cbf-98b3-975abbbddeee",
        "started_at": datetime.now(timezone.utc).isoformat()
    },
    {
        "session_id": "session-gpt4-001",
        "agent": "GPT-4 Turbo",
        "project_id": "b231255f-6ed9-4440-80de-958bcf7b4f9f",
        "started_at": datetime.now(timezone.utc).isoformat()
    }
]

TEST_TASKS = [
    {
        "task_id": "task-frontend-001",
        "title": "Implement Whiteboard Real-Time Updates",
        "status": "doing",
        "assignee": "Claude Sonnet 4.5",
        "project_id": "6cc3ca3f-ad32-4cbf-98b3-975abbbddeee",
        "priority": "high"
    },
    {
        "task_id": "task-backend-001",
        "title": "Optimize Event Detection Patterns",
        "status": "doing",
        "assignee": "Gemini Pro",
        "project_id": "6cc3ca3f-ad32-4cbf-98b3-975abbbddeee",
        "priority": "medium"
    },
    {
        "task_id": "task-memory-001",
        "title": "Design Shared Memory Architecture",
        "status": "doing",
        "assignee": "GPT-4 Turbo",
        "project_id": "b231255f-6ed9-4440-80de-958bcf7b4f9f",
        "priority": "high"
    },
    {
        "task_id": "task-docs-001",
        "title": "Update API Documentation",
        "status": "doing",
        "assignee": "Claude Sonnet 4.5",
        "project_id": "6cc3ca3f-ad32-4cbf-98b3-975abbbddeee",
        "priority": "low"
    }
]


def publish_session_events(r: redis.Redis):
    """Publish session.started events to Redis"""
    print("📡 Publishing session events...")

    for session in TEST_SESSIONS:
        event = {
            "event_type": "session.started",
            "entity_id": session["session_id"],
            "agent": session["agent"],
            "data": {
                "project_id": session["project_id"],
                "started_at": session["started_at"]
            }
        }

        r.publish("events:session", json.dumps(event))
        print(f"  ✅ Published: {session['agent']} (session: {session['session_id']})")


def publish_task_events(r: redis.Redis):
    """Publish task.created events to Redis"""
    print("\n📋 Publishing task events...")

    for task in TEST_TASKS:
        event = {
            "event_type": "task.created",
            "entity_id": task["task_id"],
            "agent": task["assignee"],
            "data": {
                "title": task["title"],
                "status": task["status"],
                "assignee": task["assignee"],
                "project_id": task["project_id"],
                "priority": task.get("priority", "medium")
            }
        }

        r.publish("events:task", json.dumps(event))
        print(f"  ✅ Published: {task['title']} (assignee: {task['assignee']})")


def main():
    """Main entry point"""
    print("=" * 70)
    print("Populating Whiteboard with Test Data")
    print("=" * 70)

    try:
        # Connect to Redis
        r = redis.from_url(REDIS_URL)
        r.ping()
        print(f"✅ Connected to Redis: {REDIS_URL}\n")

        # Publish events
        publish_session_events(r)
        publish_task_events(r)

        print("\n" + "=" * 70)
        print("✅ All events published successfully!")
        print("=" * 70)
        print(f"\nSummary:")
        print(f"  - {len(TEST_SESSIONS)} sessions started")
        print(f"  - {len(TEST_TASKS)} tasks created")
        print(f"\n👀 Check the whiteboard at: http://localhost:3737")

    except redis.ConnectionError:
        print("❌ Failed to connect to Redis")
        print("   Make sure Redis is running: docker compose ps llm-streamer-redis")
        return 1
    except Exception as e:
        print(f"❌ Error: {e}")
        return 1

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
