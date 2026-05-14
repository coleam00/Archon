#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Generate a self-contained HTML companion page from a module's MENU.yaml.

Usage:
    build_html.py --module <module-dir> [--output <filename>]
"""

import argparse
import json
import re
import sys
from pathlib import Path


def parse_yaml_value(text: str, key: str) -> str | None:
    """Extract a top-level scalar value from YAML text."""
    m = re.search(rf"^{re.escape(key)}:\s*(.+)$", text, re.MULTILINE)
    if m:
        val = m.group(1).strip().strip("\"'")
        return val
    return None


def parse_steps(text: str) -> list[dict]:
    """Parse steps from MENU.yaml text into a list of dicts."""
    steps: list[dict] = []
    # Split on step boundaries (lines starting with "  - id:" or "- id:")
    step_blocks = re.split(r"(?m)^[ \t]*- id:\s*", text)
    if not step_blocks:
        return steps

    for block in step_blocks[1:]:  # skip text before first step
        step: dict = {}
        # id is the first line
        lines = block.split("\n")
        step["id"] = lines[0].strip().strip("\"'")

        # Extract simple fields
        for field in ("title", "expect", "concept", "time"):
            m = re.search(rf"^\s+{field}:\s*(.+)$", block, re.MULTILINE)
            if m:
                step[field] = m.group(1).strip().strip("\"'")

        # Extract summary boolean
        m = re.search(r"^\s+summary:\s*(true|false)", block, re.MULTILINE | re.IGNORECASE)
        if m:
            step["summary"] = m.group(1).lower() == "true"

        # Extract main prompt (block scalar after "prompt: |")
        prompt_m = re.search(r"^\s+prompt:\s*\|?\s*\n((?:[ \t]+.+\n?)+)", block, re.MULTILINE)
        if prompt_m:
            raw = prompt_m.group(1)
            # Find minimum indentation
            indent_lines = [ln for ln in raw.split("\n") if ln.strip()]
            if indent_lines:
                min_indent = min(len(ln) - len(ln.lstrip()) for ln in indent_lines)
                step["prompt"] = "\n".join(ln[min_indent:] for ln in raw.rstrip("\n").split("\n"))

        # Extract variations
        variations: list[dict] = []
        var_section = re.search(r"^\s+variations:\s*\n((?:[ \t]+.+\n?)+)", block, re.MULTILINE)
        if var_section:
            var_text = var_section.group(1)
            var_blocks = re.split(r"(?m)^\s+- label:\s*", var_text)
            for vb in var_blocks[1:]:
                v: dict = {}
                vb_lines = vb.split("\n")
                v["label"] = vb_lines[0].strip().strip("\"'")
                vp = re.search(r"^\s+prompt:\s*\|?\s*\n((?:[ \t]+.+\n?)+)", vb, re.MULTILINE)
                if vp:
                    raw_vp = vp.group(1)
                    indent_lines_vp = [ln for ln in raw_vp.split("\n") if ln.strip()]
                    if indent_lines_vp:
                        min_ind = min(len(ln) - len(ln.lstrip()) for ln in indent_lines_vp)
                        v["prompt"] = "\n".join(ln[min_ind:] for ln in raw_vp.rstrip("\n").split("\n"))
                variations.append(v)
        if variations:
            step["variations"] = variations

        # Extract code blocks (list of strings)
        code_section = re.search(r"^\s+code:\s*\n((?:\s+-\s*.+\n?)+)", block, re.MULTILINE)
        if code_section:
            codes = re.findall(r'^\s+-\s*["\']?(.*?)["\']?\s*$', code_section.group(1), re.MULTILINE)
            if codes:
                step["code"] = codes

        # Extract spec previews
        spec_section = re.search(r"^\s+spec:\s*\n((?:[ \t]+.+\n?)+)", block, re.MULTILINE)
        if spec_section:
            specs: list[dict] = []
            spec_blocks = re.split(r"(?m)^\s+- title:\s*", spec_section.group(1))
            for sb in spec_blocks[1:]:
                s: dict = {}
                sb_lines = sb.split("\n")
                s["title"] = sb_lines[0].strip().strip("\"'")
                sc = re.search(r"^\s+content:\s*\|?\s*\n((?:[ \t]+.+\n?)+)", sb, re.MULTILINE)
                if sc:
                    raw_sc = sc.group(1)
                    sc_lines = [ln for ln in raw_sc.split("\n") if ln.strip()]
                    if sc_lines:
                        mi = min(len(ln) - len(ln.lstrip()) for ln in sc_lines)
                        s["content"] = "\n".join(ln[mi:] for ln in raw_sc.rstrip("\n").split("\n"))
                specs.append(s)
            if specs:
                step["spec"] = specs

        steps.append(step)

    return steps


HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;background:#f5f7fa;color:#333;line-height:1.6}}
header{{background:#232f3e;color:#fff;padding:0 24px;height:56px;display:flex;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}}
header h1{{font-size:18px;font-weight:600}}
.badge{{background:#ff9900;color:#232f3e;font-size:12px;font-weight:700;padding:2px 10px;border-radius:12px;margin-left:12px}}
.hamburger{{display:none;background:none;border:none;color:#fff;font-size:24px;cursor:pointer;margin-right:12px}}
.sidebar{{position:fixed;top:56px;left:0;bottom:0;width:280px;background:#37475a;overflow-y:auto;z-index:90;transition:transform .3s}}
.sidebar-header{{padding:16px;border-bottom:1px solid #4a5b6e}}
.sidebar-header h2{{color:#fff;font-size:14px;margin-bottom:8px}}
.progress-bar{{background:#2a3a4a;border-radius:4px;height:8px;overflow:hidden}}
.progress-fill{{background:#ff9900;height:100%;transition:width .3s}}
.progress-text{{color:#aab7c4;font-size:12px;margin-top:4px}}
.step-list{{list-style:none;padding:8px 0}}
.step-item{{display:flex;align-items:center;padding:10px 16px;cursor:pointer;color:#d5dbdb;font-size:14px;border-left:3px solid transparent;transition:all .15s}}
.step-item:hover{{background:#4a5b6e}}
.step-item.active{{background:#4a5b6e;border-left-color:#ff9900;color:#fff}}
.step-item.completed .step-check{{color:#4caf50}}
.step-check{{width:22px;margin-right:10px;font-size:16px;flex-shrink:0;text-align:center;color:#5a6b7e}}
.step-label{{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.step-time{{color:#8a9bae;font-size:11px;margin-left:8px;white-space:nowrap}}
.main{{margin-left:280px;margin-top:56px;min-height:calc(100vh - 56px);display:flex;flex-direction:column}}
.content{{max-width:820px;width:100%;margin:0 auto;padding:32px 40px;flex:1}}
.content h2{{font-size:26px;color:#232f3e;margin-bottom:8px}}
.intro{{font-size:16px;color:#555;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #e0e0e0}}
.prompt-block{{background:#fff8e1;border-left:4px solid #ff9900;border-radius:4px;margin:20px 0;padding:0;overflow:hidden}}
.prompt-header{{background:#fff0c2;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;color:#8a6d00}}
.prompt-header span::before{{content:'\\1F916 '}}
.prompt-body{{padding:16px}}
.prompt-body pre{{margin:0;white-space:pre-wrap;font-size:13.5px;line-height:1.55;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;color:#5a4500}}
.copy-btn{{background:#ff9900;color:#fff;border:none;padding:4px 12px;border-radius:3px;font-size:12px;cursor:pointer;font-weight:600;transition:background .15s}}
.copy-btn:hover{{background:#ec8e00}}
.copy-btn.copied{{background:#4caf50}}
.variations-block{{margin:12px 0 20px;border:1px solid #e0dcc8;border-radius:4px;overflow:hidden}}
.variations-toggle{{background:#f5f0e0;padding:8px 16px;font-size:13px;font-weight:600;color:#8a6d00;cursor:pointer;display:flex;align-items:center;justify-content:space-between;border:none;width:100%}}
.variations-toggle:hover{{background:#ede8d4}}
.variations-toggle::after{{content:'\\25B8';transition:transform .2s}}
.variations-toggle.open::after{{content:'\\25BE'}}
.variations-content{{display:none;padding:0}}
.variations-content.open{{display:block}}
.variation-item{{padding:12px 16px;border-top:1px solid #e0dcc8}}
.variation-label{{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#8a6d00;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between}}
.variation-item pre{{margin:0;white-space:pre-wrap;font-size:13px;line-height:1.5;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;color:#5a4500}}
.code-block{{position:relative;background:#1a1a2e;border-radius:6px;margin:16px 0;overflow:hidden}}
.code-block .copy-btn{{position:absolute;top:8px;right:8px}}
.code-block pre{{padding:16px;overflow-x:auto;color:#e0e0e0;font-size:13.5px;line-height:1.5;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace}}
.callout{{border-radius:6px;padding:16px 20px;margin:20px 0;font-size:14.5px}}
.callout-title{{font-weight:700;margin-bottom:4px;font-size:13px;text-transform:uppercase;letter-spacing:.5px}}
.callout.expect{{background:#e3f2fd;border-left:4px solid #2196f3}}
.callout.expect .callout-title{{color:#1565c0}}
.callout.concept{{background:#e8f5e9;border-left:4px solid #4caf50}}
.callout.concept .callout-title{{color:#2e7d32}}
.callout.spec{{background:#f3e5f5;border-left:4px solid #9c27b0}}
.callout.spec .callout-title{{color:#6a1b9a}}
.callout.spec pre{{margin:8px 0 0;white-space:pre-wrap;font-size:13px;line-height:1.5;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;color:#4a148c}}
.callout.summary{{background:#f3e5f5;border-left:4px solid #9c27b0;font-size:15px}}
.callout.summary .callout-title{{color:#6a1b9a}}
.callout ul{{margin:8px 0 0 20px}}
.callout li{{margin:4px 0}}
.nav-buttons{{display:flex;justify-content:space-between;align-items:center;padding:24px 0;margin-top:32px;border-top:1px solid #e0e0e0;gap:12px;flex-wrap:wrap}}
.nav-btn{{padding:10px 24px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:background .15s}}
.nav-btn.prev{{background:#e0e0e0;color:#333}}.nav-btn.prev:hover{{background:#ccc}}
.nav-btn.next{{background:#232f3e;color:#fff}}.nav-btn.next:hover{{background:#37475a}}
.nav-btn.complete{{background:#ff9900;color:#fff}}.nav-btn.complete:hover{{background:#ec8e00}}
.nav-btn.complete.done{{background:#4caf50}}
.nav-btn:disabled{{opacity:.4;cursor:default}}
footer{{background:#232f3e;color:#aab7c4;padding:24px 40px;text-align:center;font-size:13px;margin-left:280px}}
footer a{{color:#ff9900;text-decoration:none}}
footer a:hover{{text-decoration:underline}}
@media(max-width:768px){{
.hamburger{{display:block}}
.sidebar{{transform:translateX(-100%)}}
.sidebar.open{{transform:translateX(0)}}
.main,footer{{margin-left:0}}
.content{{padding:24px 16px}}
}}
@media print{{
.sidebar,.hamburger,.nav-buttons,footer{{display:none!important}}
.main{{margin-left:0!important}}
header{{position:static}}
.prompt-block,.code-block,.callout{{break-inside:avoid}}
}}
</style>
</head>
<body>
<header>
<button class="hamburger" onclick="document.querySelector('.sidebar').classList.toggle('open')" aria-label="Toggle sidebar">\\u2630</button>
<h1>{header_title}</h1>
<span class="badge">{badge}</span>
</header>
<nav class="sidebar" id="sidebar">
<div class="sidebar-header">
<h2>{module_name}</h2>
<div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
<div class="progress-text" id="progressText">0 / {step_count} steps completed</div>
</div>
<ul class="step-list" id="stepList"></ul>
</nav>
<div class="main">
<div class="content" id="content"></div>
<footer>{footer_html}</footer>
</div>
<script>
const STEPS={steps_json};
const KEY='{storage_key}';
const TOTAL={step_count};
let state=JSON.parse(localStorage.getItem(KEY)||'{{"current":0,"completed":[]}}');
if(!Array.isArray(state.completed))state.completed=[];

function save(){{localStorage.setItem(KEY,JSON.stringify(state))}}
function esc(s){{let d=document.createElement('div');d.textContent=s;return d.innerHTML}}

function copyText(text,btn){{
navigator.clipboard.writeText(text).then(()=>{{btn.textContent='Copied!';btn.classList.add('copied');setTimeout(()=>{{btn.textContent='Copy';btn.classList.remove('copied')}},1500)}});
}}

function renderSidebar(){{
const list=document.getElementById('stepList');
list.innerHTML=STEPS.map((s,i)=>{{
const done=state.completed.includes(i);
const cls=(i===state.current?'active':'')+(done?' completed':'');
const time=s.time?'<span class="step-time">'+esc(s.time)+'</span>':'';
return '<li class="step-item '+cls+'" onclick="goTo('+i+')"><span class="step-check">'+(done?'\\u2705':'\\u25CB')+'</span><span class="step-label">'+(i+1)+'. '+esc(s.t)+'</span>'+time+'</li>';
}}).join('');
const n=state.completed.length;
document.getElementById('progressFill').style.width=(n/TOTAL*100)+'%';
document.getElementById('progressText').textContent=n+' / '+TOTAL+' steps completed';
}}

function renderStep(i){{
const s=STEPS[i];
const done=state.completed.includes(i);
let h='<h2>Step '+(i+1)+': '+esc(s.t)+'</h2>';
if(s.expect)h+='<p class="intro">'+s.expect+'</p>';

// Main prompt
if(s.prompt){{
const pid='p'+i;
h+='<div class="prompt-block" id="'+pid+'"><div class="prompt-header"><span>AI Prompt \\u2014 Copy into your GDIT framework session</span><button class="copy-btn" onclick="copyText(STEPS['+i+'].prompt,this)">Copy</button></div><div class="prompt-body"><pre>'+esc(s.prompt)+'</pre></div></div>';
}}

// Variations
if(s.variations&&s.variations.length){{
h+='<div class="variations-block"><button class="variations-toggle" onclick="this.classList.toggle(\\'open\\');this.nextElementSibling.classList.toggle(\\'open\\')">\\uD83D\\uDCAC Shorter prompt variations \\u2014 same results, less typing</button><div class="variations-content">';
s.variations.forEach((v,vi)=>{{
h+='<div class="variation-item"><div class="variation-label">'+esc(v.label)+'<button class="copy-btn" onclick="copyText(STEPS['+i+'].variations['+vi+'].prompt,this)">Copy</button></div><pre>'+esc(v.prompt)+'</pre></div>';
}});
h+='</div></div>';
}}

// Expect callout
if(s.expect)h+='<div class="callout expect"><div class="callout-title">\\uD83D\\uDD0D What to Expect</div>'+s.expect+'</div>';

// Concept callout
if(s.concept)h+='<div class="callout concept"><div class="callout-title">\\uD83D\\uDCA1 Key Concept</div>'+s.concept+'</div>';

// Code blocks
if(s.code){{
s.code.forEach((c,ci)=>{{
const cid='c'+i+'_'+ci;
h+='<div class="code-block" id="'+cid+'"><button class="copy-btn" onclick="copyText(STEPS['+i+'].code['+ci+'],this)">Copy</button><pre>'+esc(c)+'</pre></div>';
}});
}}

// Spec previews
if(s.spec){{
s.spec.forEach(sp=>{{
h+='<div class="callout spec"><div class="callout-title">\\uD83D\\uDCC4 Spec File \\u2014 '+esc(sp.title)+'</div><pre>'+esc(sp.content)+'</pre></div>';
}});
}}

// Summary
if(s.summary){{
h+='<div class="callout summary"><div class="callout-title">\\uD83C\\uDF89 Module Complete</div><p>Congratulations! You have completed this training module.</p></div>';
}}

// Navigation
h+='<div class="nav-buttons">';
h+=i>0?'<button class="nav-btn prev" onclick="goTo('+(i-1)+')">\\u2190 Previous</button>':'<button class="nav-btn prev" disabled>\\u2190 Previous</button>';
h+='<button class="nav-btn complete '+(done?'done':'')+'" onclick="toggleComplete('+i+')">'+(done?'\\u2713 Completed':'Mark Complete')+'</button>';
h+=i<STEPS.length-1?'<button class="nav-btn next" onclick="goTo('+(i+1)+')">Next \\u2192</button>':'<button class="nav-btn next" disabled>Next \\u2192</button>';
h+='</div>';

document.getElementById('content').innerHTML=h;
}}

function goTo(i){{
state.current=i;save();renderSidebar();renderStep(i);
document.getElementById('content').scrollIntoView({{behavior:'smooth'}});
document.querySelector('.sidebar').classList.remove('open');
}}

function toggleComplete(i){{
const idx=state.completed.indexOf(i);
if(idx===-1){{state.completed.push(i);if(i<STEPS.length-1){{state.current=i+1;save();renderSidebar();renderStep(i+1);document.getElementById('content').scrollIntoView({{behavior:'smooth'}});return}}}}
else state.completed.splice(idx,1);
save();renderSidebar();renderStep(state.current);
}}

renderSidebar();renderStep(state.current);
</script>
</body>
</html>"""


def build_steps_json(steps: list[dict]) -> str:
    """Convert parsed steps to a JSON array for the JS STEPS constant."""
    js_steps = []
    for s in steps:
        entry: dict = {"t": s.get("title", "")}
        if "prompt" in s:
            entry["prompt"] = s["prompt"]
        if "variations" in s:
            entry["variations"] = s["variations"]
        if "expect" in s:
            entry["expect"] = s["expect"]
        if "concept" in s:
            entry["concept"] = s["concept"]
        if "time" in s:
            entry["time"] = s["time"]
        if s.get("summary"):
            entry["summary"] = True
        if "code" in s:
            entry["code"] = s["code"]
        if "spec" in s:
            entry["spec"] = s["spec"]
        js_steps.append(entry)
    return json.dumps(js_steps, ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate HTML companion page from MENU.yaml.")
    parser.add_argument("--module", required=True, help="Path to module directory")
    parser.add_argument("--output", default="course.html", help="Output filename (default: course.html)")
    args = parser.parse_args()

    mod_dir = Path(args.module)
    menu_path = mod_dir / "MENU.yaml"

    if not menu_path.exists():
        print(f"[ERROR] MENU.yaml not found in {mod_dir}", file=sys.stderr)
        return 1

    text = menu_path.read_text(encoding="utf-8")

    name = parse_yaml_value(text, "name") or "Training Module"
    steps = parse_steps(text)

    if not steps:
        print("[ERROR] No steps found in MENU.yaml", file=sys.stderr)
        return 1

    steps_json = build_steps_json(steps)
    step_count = len(steps)

    # Derive storage key from module dir name
    storage_key = f"training-module-{mod_dir.name}"

    html = HTML_TEMPLATE.format(
        title=f"{name} — Training",
        header_title="Training",
        badge=name,
        module_name=name,
        step_count=step_count,
        steps_json=steps_json,
        storage_key=storage_key,
        footer_html="Training Module",
    )

    out_path = mod_dir / args.output
    out_path.write_text(html, encoding="utf-8")
    print(f"[OK] Generated {out_path} ({step_count} steps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
