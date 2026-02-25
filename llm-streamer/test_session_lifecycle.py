#!/usr/bin/env python3
"""
Test Session Lifecycle Events

Tests ending a session and verifying it's removed from the whiteboard.
"""

import json
import os
import redis

REDIS_URL = os.getenv("REDIS_URL", "redis://llm-streamer-redis:6379")

def end_session(r: redis.Redis, session_id: str, agent: str):
    """Publish session.ended event to Redis"""
    event = {
        "event_type": "session.ended",
        "entity_id": session_id,
        "agent": agent,
        "data": {
            "ended_at": "2026-02-16T17:05:00.000000+00:00",
            "reason": "Testing session lifecycle"
        }
    }

    r.publish("events:session", json.dumps(event))
    print(f"✅ Published session.ended event for {agent} (session: {session_id})")

def main():
    """Main entry point"""
    print("=" * 70)
    print("Testing Session Lifecycle Events")
    print("=" * 70)

    try:
        r = redis.from_url(REDIS_URL)
        r.ping()
        print(f"✅ Connected to Redis: {REDIS_URL}\n")

        # End the Gemini Pro session
        end_session(r, "session-gemini-001", "Gemini Pro")

        print("\n✅ Session ended event published!")
        print("   Check whiteboard - Gemini Pro session should be removed")

    except Exception as e:
        print(f"❌ Error: {e}")
        return 1

    return 0

if __name__ == "__main__":
    import sys
    sys.exit(main())
