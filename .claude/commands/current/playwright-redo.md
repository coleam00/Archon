Hello, I need you to do nothing other than following my instructions precisely, you guys keep fucking left and
right 5 hours now.

#1. understand how this works and ultimately where its going to fail @orchestrator_agent/sub_agents/application_submitter_agent/tests/test_scripts/captcha_tests/orchestrator_agent/sub_agents/application_submitter_agent/tests/test_scripts/captcha_tests/greenhousetester.py for now just put it in context.

#2 now using the playwright mcp tool visit https://www.chronograph.pe/jobs/?gh_jid=4825971007

#3 attempt to use the logic in the functions or if they dont work this is what i need greenhouse_discover_all_fields()
a) Determine all fields names and the function used to extract them dymanically here no helpers
b) input all regular text fields and remember the function used to do it. Create a validation that will not allow it to proceed until it detemrines what it entered is correct.
c) input all drop down items, following the format of input, wait, click or whatever it is to get it to stay. Then create a validation method where you / it cannot proceed until it detemines that he value originally place to it is in the box.
there then remember it and record it.
d) click the checkbox, remember how you did it and record it. validate it.
e) click submit and remember what you did and record it, it will fail
ENTER EVERY SINGLE FIELD ON THIS FORM OR WE WILL REPEAT IT UNTIL YOU DO I NEED YOU TO UNDERSTAND WHAT IS GOING ON AND WHAT NEEDS TO BE CODED

#4) Do not make anything rely on names of fields as this will need to be dynamic they are different at every
green application.

#5 we need four five functions that will work, and we will test in a different script with browseruse but edit
this file so that it is plug and play and will work @orchestrator_agent/sub_agents/application_submitter_agent/te
sts/test_scripts/captcha_tests/greenhouse_dynamic_actions.py we are using browseruse and playwright so they will
be the same.. whatever you use to get the job done most likely it needs a little adaption then we good. This eats
context so minimal bullshit more execution all following instructions to 5 just execute.

#6 USE PLAYWRIGHT-STYLE BROWSERUSE METHODS, NOT JAVASCRIPT

- When you tested with MCP Playwright, you used: iframe.get_by_role('textbox', name='First Name').fill('David')
- Browser-Use has THE SAME Playwright methods: greenhouse_frame.get_by_role(), greenhouse_frame.fill(), etc.
- DO NOT use evaluate() with JavaScript code
- DO NOT write complex JavaScript pattern matching
- Just use the DIRECT Playwright methods that both Browser-Use and Playwright support
- Each function should be 5-10 lines MAX, not 50 lines of JavaScript
