Here’s a tight cheatsheet so you can drive and audit it in real time.
  Actions and what they do
  • open_recaptcha_and_trigger_grid: Opens demo, clicks checkbox, waits for
    grid. Saves:
    • grid-viewport_before-…png
    • grid-viewport_after-…png
    • grid-screenshot_after_checkbox-…png
  • report_debug_state: Reads DOM-only rows/cols + instruction; set S to
    "3x3"|"4x4".
  • solve_recaptcha_grid(preferred_size=S): One “solve round”:
    • Sends the exact submission image (for 2Captcha):
      • 2captcha-submission_roundN-…png (this is the payload; on 4x4 it will
        look like one big image, not 16 tiles)
    • Clicks tiles by coordinates
    • Immediately saves grid images you should inspect:
      • grid-after_clicks_immediate_roundN-seq####-….jpg (freshly updated,
        padded table bbox)
      • grid-after_clicks_roundN-seq####-….jpg
    • When it presses a button (Next/Verify/Skip), it immediately saves:
      • grid-post_next_immediate_roundN-seq####-….jpg (or post_verify /
        post_skip)
      • grid-viewport_post_next-seq####-….jpg (or post_verify / post_skip)
    • After that, it saves a final per-round grid shot:
      • grid-after_verify_roundN-seq####-….jpg
  • capture_viewport_context: Saves a consistent full-viewport 1920×1080:
    • grid-viewport_context-….png (or .jpg if we switch it)
  • get_grid_state_light: Returns {"bframePresent": true|false} only.
  • reopen_and_press_check: Re-clicks checkbox (use once if expired/checkbox
    view).
  • verify_solution: Saves a verification grid clip.

  File names and what to look for
  • “2captcha-submission…”: exact image sent to solver (what 2Captcha sees).
  • “grid-after_clicks_immediate…”: this is the image the LLM should react to
    right after clicks.
  • “grid-post_next_immediate…” + “grid-viewport_post_next…”: immediate
    images after pressing a button (Next/Verify/Skip). These are the ones to
    decide the next step on.
  • “grid-after_verify_round…”: per-round final grid shot (may be unchanged
    if Verify didn’t advance).
  • The seq#### counter is monotonic across the whole run; use seq order (not
    round number) to see time progression. “round1” restarts each time
    solve_recaptcha_grid is called, so seq#### is your ground truth.

  Why you sometimes see a “single tile”
  • On 4x4 grids, reCAPTCHA uses one large image under the grid; 2Captcha
    expects that full image. The “2captcha-submission…” file being one big
    image is expected and correct.

  If it still “goes fast and wrong”
  • Use the immediate files only for decisions:
    • After clicks: grid-after_clicks_immediate…
    • After button: grid-post_{action}_immediate… and
      grid-viewport_post_{action}…
  • If you want me to clamp the button logic to be safer (no Next unless
    clicks_done>0; Skip only if instruction allows and no clicks; else
    Verify), say the word and I’ll wire it in.

  Quick run checklist
  • Call in this order:
    • open_recaptcha_and_trigger_grid
    • report_debug_state → set S
    • solve_recaptcha_grid(preferred_size=S)
    • Then loop:
      • capture_viewport_context
      • get_grid_state_light
      • Decide one action (solve again / verify / reopen once)
  • To know “when the agent is viewing”:
    • Look for grid-after_clicks_immediate… or grid-post_{action}_immediate…
      and grid-viewport_post_{action}…
    • Those are saved right after the click batch or button press; the LLM
      should react on those.

