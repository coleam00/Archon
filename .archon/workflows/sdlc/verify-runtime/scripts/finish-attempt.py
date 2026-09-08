"""Stop retries on cleanup failure and complete the final malformed attempt explicitly."""

import json
import os

result = json.loads(os.environ["INPUTS_ASSESSMENT"])
if os.environ["INPUTS_TEARDOWN_OK"] != "true":
    result.update(
        status="inconclusive",
        reason="teardown failed; external owner must clean up. "
        f"Prior assessment: {result['status']}: {result['reason']}",
    )
elif (
    result["status"] == "malformed"
    and int(os.environ["INPUTS_ATTEMPT"]) >= int(os.environ["INPUTS_ATTEMPT_LIMIT"])
):
    result.update(
        status="inconclusive",
        reason=f"malformed report after exhausting the retry budget: {result['reason']}",
    )
result.update(done=result["status"] != "malformed", checkout=os.environ["INPUTS_CHECKOUT"])
print(json.dumps(result))
