#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
# ]
# ///

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

from utils.constants import ensure_session_log_dir

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass  # dotenv is optional


def get_tts_script_path():
    """
    Determine which TTS script to use based on available API keys.
    Priority order: ElevenLabs > OpenAI > pyttsx3
    """
    # Get current script directory and construct utils/tts path
    script_dir = Path(__file__).parent
    tts_dir = script_dir / "utils" / "tts"

    # Check for ElevenLabs API key (2nd priority - best quality)
    if os.getenv("ELEVENLABS_API_KEY"):
        elevenlabs_script = tts_dir / "elevenlabs_tts.py"
        if elevenlabs_script.exists():
            return str(elevenlabs_script)

    # Check for OpenAI API key (1st priority)
    if os.getenv("OPENAI_API_KEY"):
        openai_script = tts_dir / "openai_tts.py"
        if openai_script.exists():
            return str(openai_script)
    # Check for ElevenLabs API key (2nd priority - best quality)
    if os.getenv("ELEVENLABS_API_KEY"):
        elevenlabs_script = tts_dir / "elevenlabs_tts.py"
        if elevenlabs_script.exists():
            return str(elevenlabs_script)
    
    # Fall back to pyttsx3 (no API key required)
    pyttsx3_script = tts_dir / "pyttsx3_tts.py"
    if pyttsx3_script.exists():
        return str(pyttsx3_script)

    return None


def announce_notification():
    """Announce that the agent needs user input."""
    try:
        tts_script = get_tts_script_path()
        if not tts_script:
            print("Debug: No TTS script found", file=sys.stderr)
            return  # No TTS scripts available

        # Get engineer name if available
        engineer_name = os.getenv("ENGINEER_NAME", "").strip()

        # Create notification message with 30% chance to include name
        if engineer_name and random.random() < 0.3:
            notification_message = f"{engineer_name}, your agent needs your input"
        else:
            notification_message = "Your agent needs your input"

        # Debug: Show what we're about to run
        print(
            f"Debug: Running TTS with message: {notification_message}", file=sys.stderr
        )
        print(f"Debug: TTS script path: {tts_script}", file=sys.stderr)

        # Call the TTS script with the notification message
        result = subprocess.run(
            ["uv", "run", tts_script, notification_message],
            capture_output=False,  # Don't capture - let audio play!
            timeout=10,  # 10-second timeout
            text=True,
        )

        if result.returncode != 0:
            print(f"Debug: TTS failed with code {result.returncode}", file=sys.stderr)
            if result.stderr:
                print(f"Debug: TTS stderr: {result.stderr}", file=sys.stderr)

    except (subprocess.TimeoutExpired, subprocess.SubprocessError, FileNotFoundError):
        # Fail silently if TTS encounters issues
        pass
    except Exception:
        # Fail silently for any other errors
        pass


def main():
    try:
        # Parse command line arguments
        parser = argparse.ArgumentParser()
        parser.add_argument(
            "--notify", action="store_true", help="Enable TTS notifications"
        )
        args = parser.parse_args()

        # Read JSON input from stdin
        input_data = json.loads(sys.stdin.read())

        # Extract session_id
        session_id = input_data.get("session_id", "unknown")

        # Ensure session log directory exists
        log_dir = ensure_session_log_dir(session_id)
        log_file = log_dir / "notification.json"

        # Read existing log data or initialize empty list
        if log_file.exists():
            with open(log_file) as f:
                try:
                    log_data = json.load(f)
                except (json.JSONDecodeError, ValueError):
                    log_data = []
        else:
            log_data = []

        # Append new data
        log_data.append(input_data)

        # Write back to file with formatting
        with open(log_file, "w") as f:
            json.dump(log_data, f, indent=2)

        # Announce notification via TTS when --notify flag is set
        # Play sound for all notifications
        if args.notify:
            announce_notification()

        sys.exit(0)

    except json.JSONDecodeError:
        # Handle JSON decode errors gracefully
        sys.exit(0)
    except Exception:
        # Handle any other errors gracefully
        sys.exit(0)


if __name__ == "__main__":
    main()
