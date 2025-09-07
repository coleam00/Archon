For this task I need you 
1. Look at how the below browser use functions are created solely with playwright/browsueruse movements.  Retain that information in context.
2. Fire up the playwright mcp and go to:
https://www.mangomint.com/careers/?ashby_jid=264e4a80-cbd4-42a8-912e-68f67d608ffb

4. On top there is a tab called `Applicaiton` it is hidden.  Determine what it would take to create a function that clicks on it by doint it yourself.
Enter that function here:
```python
import code here





```




5. Go Back to https://www.mangomint.com/careers/?ashby_jid=264e4a80-cbd4-42a8-912e-68f67d608ffb
- Scroll to the bottom and find and click the button to apply adn record what steps and code would be needed, put that code here:
```python
import code here




```
6.  In the Application find a way to search for all labels on the form fields.
record the code it took to do so right here
```python
import code



```

7.  On the application form you arrived at through either method.
find and click on the upload file button, record the code needed to do so and record here
```python
import code here






```
8. On the application form, find the test fields and enter some values
record the code and process here making sure to use the dynamic label found above in the logic:
```python
import code here



```

9. Find any clickable elements and click on them with an appropriate response, record
the code needed to complete it including the dynamic labeling here:
```python

```

10. Identify any remaining upload buttons or fields and record the code included the dymaic labneling needed if any
```python

```


11. Make sure all button click and submittals are the same for al clicks and submits, if not please record hte code
needed ot complete and record here:
```python


```



@controller.action(description="Click the submit button on Greenhouse form")
async def greenhouse_find_and_click_submit(browser_session: BrowserSession) -> ActionResult:
    """
    Finds and clicks the submit button on a Greenhouse form.
    Works with variations like 'Submit', 'Submit application', etc.
    
    Usage in prompt:
    {"greenhouse_find_and_click_submit": {}}
    
    Returns:
        ActionResult indicating if submission was attempted
    """
    try:
        page = await browser_session.get_current_page()
        iframe = page.frame_locator('iframe[title="Greenhouse Job Board"]')
        
        # Find submit button (partial match on 'Submit')
        submit_button = iframe.get_by_role('button', name='Submit')
        
        # Check if enabled - MUST await
        is_disabled = await submit_button.is_disabled()
        if is_disabled:
            logger.warning("⚠️ Submit button is disabled (missing required fields)")
            return ActionResult(extracted_content="Submit button disabled - check required fields", is_done=False)
        
        # Click submit - MUST await
        await submit_button.click()
        logger.info("✅ Clicked submit button")
        return ActionResult(extracted_content="Submitted application form", is_done=True)
    except Exception as e:
        logger.error(f"❌ Submit failed: {e}")
        return ActionResult(error=f"Could not submit: {str(e)}", is_done=False)


@controller.action(description="Select a dropdown option by field intent") 
async def greenhouse_smart_fill_dropdown(browser_session: BrowserSession, field_intent: str, value: str) -> ActionResult:
    """
    Selects a dropdown option in Greenhouse form.
    Uses click → type → Enter pattern that works reliably.
    
    Usage in prompt:
    {"greenhouse_smart_fill_dropdown": {"field_intent": "school", "value": "MIT"}}
    {"greenhouse_smart_fill_dropdown": {"field_intent": "degree", "value": "Bachelor"}}
    
    Args:
        field_intent: Partial match for dropdown label
        value: Option text to select
    
    Returns:
        ActionResult indicating success
    """
    try:
        # LOG THE INPUTS SO WE KNOW WHAT WE'RE VALIDATING
        logger.info(f"📋 DROPDOWN SELECTION STARTING:")
        logger.info(f"   Field: '{field_intent}'")
        logger.info(f"   Value to select: '{value}'")
        logger.info(f"   VALIDATION REQUIREMENT: Selected text MUST contain '{value}'")
        
        page = await browser_session.get_current_page()
        iframe = page.frame_locator('iframe[title="Greenhouse Job Board"]')

        # Helpers
        def _norm_label(s: str) -> str:
            return re.sub(r"\s+", " ", (s or "").strip().lower())

        async def _resolve_label(el):
            label = await el.get_attribute('aria-label')
            if label and label.strip():
                return label.strip()
            labelledby = await el.get_attribute('aria-labelledby')
            if labelledby:
                for id_ in labelledby.split():
                    ref = iframe.locator(f'#{id_}')
                    if await ref.count() > 0:
                        txt = await ref.first.text_content()
                        if txt and txt.strip():
                            return txt.strip()
            # Nearest visible label
            try:
                lab = el.locator('xpath=ancestor::*[self::div or self::fieldset][.//label]').locator('label').first
                if await lab.count() > 0:
                    txt = await lab.text_content()
                    if txt and txt.strip():
                        return txt.strip()
            except Exception:
                pass
            # Preceding label
            try:
                lab2 = el.locator('xpath=preceding::label[1]').first
                if await lab2.count() > 0:
                    txt = await lab2.text_content()
                    if txt and txt.strip():
                        return txt.strip()
            except Exception:
                pass
            return ''

        # Gather candidate dropdown elements
        candidates = []  # list of tuples (score, label, element)
        pools = []
        pools.append(('role=combobox', iframe.get_by_role('combobox')))
        pools.append(('react-select', iframe.locator('[class*="select__control"] input')))
        pools.append(('listbox', iframe.locator('[aria-haspopup="listbox"]')))
        pools.append(('select', iframe.locator('select')))

        desired = _norm_label(field_intent)
        for _name, loc in pools:
            count = await loc.count()
            for i in range(count):
                el = loc.nth(i)
                label = await _resolve_label(el)
                nlabel = _norm_label(label)
                ratio = SequenceMatcher(None, desired, nlabel).ratio()
                contains = 1.0 if (desired and (desired in nlabel or nlabel in desired)) else 0.0
                score = contains * 2.0 + ratio
                candidates.append((score, label, el))

        dropdown = None
        best_label = ''
        if candidates:
            candidates.sort(key=lambda t: t[0], reverse=True)
            best_score, best_label, dropdown = candidates[0]
            logger.info(f"🎯 Matched dropdown '{best_label}' for intent '{field_intent}' (score {best_score:.2f})")
        if dropdown is None:
            dropdown = iframe.get_by_role('combobox').first
            logger.warning(f"⚠️ No labeled dropdown matched; falling back to first combobox for intent '{field_intent}'")
        
        # Ensure in view and open dropdown
        # Find a clickable container (react-select control) or use the element itself
        container_click = dropdown.locator('xpath=ancestor::*[contains(@class, "select__control")][1]').first
        clickable = dropdown
        try:
            if await container_click.count() > 0:
                clickable = container_click
        except Exception:
            pass

        try:
            await clickable.scroll_into_view_if_needed()
        except Exception:
            pass
        await clickable.click()

        # Ensure the menu opens and options are visible
        opened = False
        for _ in range(3):
            try:
                if await iframe.get_by_role('option').count() > 0:
                    opened = True
                    break
            except Exception:
                pass
            await page.keyboard.press('ArrowDown')
            await page.wait_for_timeout(150)
            await clickable.click()
            await page.wait_for_timeout(150)

        if not opened:
            # Try Space as a last resort
            try:
                await page.keyboard.press('Space')
                await page.wait_for_timeout(150)
            except Exception:
                pass
        
        # Type to filter options  
        typed = False
        try:
            await dropdown.fill(value)
            typed = True
        except Exception:
            # Not an input; type via keyboard
            try:
                await page.keyboard.type(value, delay=20)
                typed = True
            except Exception:
                typed = False
        
        # Small delay for dropdown to filter
        await page.wait_for_timeout(500)

        # Gather visible options and choose the best match; avoid blind Enter
        options = iframe.get_by_role('option')
        opt_count = await options.count()
        logger.info(f"   Options visible: {opt_count}")
        top_preview = []
        for i in range(min(opt_count, 10)):
            try:
                txt = await options.nth(i).text_content()
                if txt:
                    top_preview.append(txt.strip())
            except Exception:
                continue
        if top_preview:
            logger.info(f"   Top options: {top_preview[:5]}")

        def _score_choice(candidate_text: str) -> float:
            cn = (candidate_text or '').strip()
            cn_norm = _norm_label(cn)
            v_norm = _norm_label(value)
            score = 0.0
            if cn_norm == v_norm:
                score += 3.0
            if v_norm and v_norm in cn_norm:
                score += 2.0
            if cn_norm and cn_norm in v_norm:
                score += 1.0
            score += SequenceMatcher(None, v_norm, cn_norm).ratio() * 2.0
            # Acronym match heuristic
            def _acr(s: str) -> str:
                toks = [t for t in s.split() if t]
                return ''.join(t[0] for t in toks).upper()
            if _acr(value) and _acr(value) == _acr(cn):
                score += 2.0
            return score

        best_idx = -1
        best_text = None
        best_score = 0.0
        for i in range(opt_count):
            try:
                txt = await options.nth(i).text_content()
            except Exception:
                continue
            if not txt:
                continue
            s = _score_choice(txt)
            if s > best_score:
                best_score = s
                best_text = txt.strip()
                best_idx = i

        # Capture previous display text (if any) before clicking a new option
        prev_display_text = None
        try:
            container_pre = dropdown.locator('xpath=ancestor::*[contains(@class, "select__control") or @role="combobox" or self::div][1]').first
            display_pre = container_pre.locator('[class*="singleValue" i], [class*="single-value" i], [class*="multiValue__label" i], [aria-live="polite"]').first
            if await display_pre.count() > 0:
                prev_display_text = (await display_pre.text_content()) or None
        except Exception:
            prev_display_text = None

        if best_idx >= 0:
            try:
                await options.nth(best_idx).click()
            except Exception:
                # fallback to Enter if clicking fails
                await page.keyboard.press('Enter')
        else:
            # as last resort, press Enter
            await page.keyboard.press('Enter')
        
        # CRITICAL: Wait for the listbox to close and selection to stabilize
        try:
            for _ in range(15):
                try:
                    if await iframe.get_by_role('option').count() == 0:
                        break
                except Exception:
                    break
                # Also try to detect aria-expanded=false on combobox
                try:
                    expanded_attr = await dropdown.get_attribute('aria-expanded')
                    if expanded_attr == 'false':
                        break
                except Exception:
                    pass
                await page.wait_for_timeout(120)
        except Exception:
            pass

        # CRITICAL: Wait and get ACTUAL selected value from DISPLAY element
        logger.info(f"🔍 VALIDATING dropdown selection for '{field_intent}'...")
        await page.wait_for_timeout(300)
        
        # Log what we're looking for
        logger.info(f"   Looking for value containing: '{value}'")
        
        # The actual selected text is typically in a nearby display element
        # Try multiple common patterns (react-select, native select, aria-live)
        container = dropdown.locator('xpath=ancestor::*[contains(@class, "select__control") or @role="combobox" or self::div][1]').first
        display_element = container.locator('[class*="singleValue" i], [class*="single-value" i], [class*="multiValue__label" i], [aria-live="polite"]').first
        
        actual_selected = None
        try:
            if await display_element.count() > 0:
                actual_selected = await display_element.text_content()
        except Exception:
            actual_selected = None
        # Fallback: native <select> option:checked
        if not actual_selected:
            try:
                selected_opt = dropdown.locator('option:checked').first
                if await selected_opt.count() > 0:
                    actual_selected = await selected_opt.text_content()
            except Exception:
                pass

        # Last fallback: use container's visible text if distinct from prior
        if not actual_selected:
            try:
                cont_text = await container.text_content()
                if cont_text:
                    cont_text = cont_text.strip()
                    if cont_text and cont_text != (prev_display_text or '').strip():
                        actual_selected = cont_text
            except Exception:
                pass
        
        # Log what we actually got
        logger.info(f"   ACTUAL SELECTED VALUE: '{actual_selected}'")
        
        # CHECK: Does our search term appear in what got selected?
        if not actual_selected:
            logger.error(f"❌ NO SELECTION DETECTED for '{field_intent}'!")
            logger.error(f"   The display element is empty or missing")
            return ActionResult(error=f"No selection detected in {field_intent}", is_done=False)
        
        # If typed value does not match closely, try discovery (handles abbreviations)
        def _norm(s: str) -> str:
            return re.sub(r"\s+", " ", (s or "").strip().lower())
        typed = _norm(value)
        selected_norm = _norm(actual_selected)

        close_enough = (
            typed in selected_norm
            or selected_norm in typed
            or SequenceMatcher(None, typed, selected_norm).ratio() >= 0.86
        )

        if not close_enough:
            logger.error(f"❌ WRONG SELECTION!")
            logger.error(f"   Expected: '{value}'")
            logger.error(f"   Got: '{actual_selected}'")
            
            # Discover the correct option
            correct_option = await discover_dropdown_option(page, dropdown, iframe, value, logger)
            
            if correct_option:
                logger.info(f"🎯 DISCOVERED correct option: '{correct_option}'")
                
                # Clear current filter/selection (works even without a clear button)
                await dropdown.click()
                await page.keyboard.press('Control+A')
                await page.keyboard.press('Backspace')
                
                # Select the discovered option
                await dropdown.click()
                await dropdown.fill(correct_option)
                await page.wait_for_timeout(500)
                await page.keyboard.press('Enter')
                await page.wait_for_timeout(300)
                
                # Verify selection
                try:
                    display_element = container.locator('[class*="singleValue"]').first
                    if await display_element.count() > 0:
                        actual_selected = await display_element.text_content()
                except:
                    actual_selected = None
                
                # Recompute selected display
                if actual_selected and _norm(actual_selected) == _norm(correct_option):
                    logger.info(f"✅ Successfully selected: '{actual_selected}'")
                    return ActionResult(extracted_content=f"Selected: {actual_selected}", is_done=False)
                else:
                    logger.error(f"❌ Selection still failed after discovery")
                    return ActionResult(error=f"Could not select '{value}'. Discovered '{correct_option}' but got '{actual_selected}'", is_done=False)
            else:
                logger.error(f"❌ Could not find a matching option for '{value}' after probing")
                # Soft outcome: report attempt instead of failing hard so logs show the tries
                return ActionResult(
                    extracted_content=f"Attempted selection for '{field_intent}' with '{value}' but could not confirm a match.",
                    is_done=False,
                )
        
        # Success - we found what we were looking for in the selected text!
        logger.info(f"✅ DROPDOWN VALIDATION SUCCESS for '{field_intent}':")
        logger.info(f"   Searched for: '{value}'")
        logger.info(f"   Actually selected: '{actual_selected}'")
        logger.info(f"   Validation: '{value.lower()}' IS FOUND in '{actual_selected.lower()}' ✓")
        logger.info(f"   CONFIRMED: The selection contains what was requested!")
        
        return ActionResult(extracted_content=f"Selected and validated: {actual_selected}", is_done=False)
    except Exception as e:
        logger.error(f"❌ Dropdown selection failed for {field_intent}: {e}")
        return ActionResult(error=f"Could not select in {field_intent}: {str(e)}", is_done=False)

