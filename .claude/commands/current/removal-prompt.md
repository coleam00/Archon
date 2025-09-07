 Keep ONLY these functions (and any trivial helpers they directly depend on):
  enable_recaptcha_audio_sniffer, enable_hcaptcha_init_sniffer,
  enable_turnstile_init_intercept, _pre_action_guard,
  _await_recaptcha_guard_if_present, _await_turnstile_guard_if_present,
  solve_captcha_audio_via_extension_quick, detect_and_handle_captcha,
  monitor_captcha_progress. You may remove CaptchaAgentOrchestrator. Do NOT
  modify any other files, controllers, exports, or actions anywhere else
  (including shared_browser_actions.py, __init__.py, and
  tests/scripts/browseruse_agents/*). Only remove content that
  safe_safe_to_remove.md marks as safe. If anything is ambiguous, stop and ask.
  First, show me a keep/remove plan and a diff preview limited to the two files.
   After edits, create remaining_functions_after_cleasing.md summarizing the
  remaining functions (1–2 sentences each).
