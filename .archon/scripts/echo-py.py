"""Simple script node test — echoes input as JSON (uv/Python runtime)."""
import json
import sys
from datetime import datetime, timezone

input_val = sys.argv[1] if len(sys.argv) > 1 else "no-input"
print(json.dumps({"echoed": input_val, "timestamp": datetime.now(timezone.utc).isoformat()}))
