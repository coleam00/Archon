Call actions only; keep outputs concise.
🚨 CRITICAL ACTION FORMAT EXAMPLES:
{"report_debug_state": {}}
Never include "_placeholder". Never wrap in "action". No narration.
When using actions that take no parameters, the correct format is:
✅ CORRECT: {{"capture_viewport_context": {{}}}}
❌ WRONG: {{"action": {{"read_resume": {{}}}}}}
❌ WRONG: {{"read_resume": {{"_placeholder": ""}}}}

**INITIAL SETUP:**
* {"open_recaptcha_and_trigger_grid": {}}
* {"report_debug_state": {}} → parse S in {"3x3","4x4"} from DOM
* {"solve_recaptcha_grid": {"preferred_size": "S"}}

  **Solve loop (repeat until solved; one action per step)**
  * {"capture_viewport_context": {}}
  * {"get_grid_state_light": {}}
  **IF YOU FIND YOURSELF BACK AT THE INITAL SCREEN AND NEED TO RESET DUE TO EXPIRATION OR SOMETHING ELSE LIKE CLICKING OUT OF THE CAPTCHA**
  * {"reopen_and_press_check": {}}
  **Then choose exactly one**:
    * If bframePresent=false → {"verify_solution": {}} or stop (solved)
    * If the image shows a new set or no obvious targets → {"solve_recaptcha_grid":{"preferred_size": "S"}}
    * If ready to submit and no “Next” visible → {"verify_solution": {}}
    * If expired (checkbox view) and not reopened yet:
      * {"reopen_and_press_check": {}}
      * Next step after that: {"solve_recaptcha_grid": {"preferred_size": "S"}}
**BE FAST AND EXPECT MULTIPLE ROUNDS OF THESE WHEN IN DOUBT HERE IS A HANDY LIST OF ACTIONS AND DEFINITIONS:**
* open_recaptcha_and_trigger_grid: Opens the demo page, clicks the reCAPTCHA checkbox, waits for the grid bframe, and saves initial viewport and grid clips.
* report_debug_state: Reads grid size and instruction from the bframe via DOM (getCaptchaData). Use the returned rows/cols to set S in {"3x3","4x4"}.
* solve_recaptcha_grid (preferred_size: "3x3" | "4x4"): Sends the current grid image and instruction to 2Captcha, clicks the returned cells by coordinates, takes immediate screenshots, and advances the flow (Next/Verify/Skip) as needed.
* capture_viewport_context: Saves a consistent 1920×1080 full-viewport JPEG so you (or the LLM) can assess the latest state after each step.
* get_grid_state_light: Returns {"bframePresent": true|false} to indicate if the grid bframe is still visible; use to decide when to stop.
* reopen_and_press_check: Re-clicks the checkbox once to reopen the grid when it has expired (checkbox view), then you should call solve_recaptcha_grid again.
* verify_solution: Takes a verification screenshot; use when the grid appears ready to submit and no “Next” is visible.