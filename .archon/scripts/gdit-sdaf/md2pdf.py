#!/usr/bin/env python3
"""
Markdown to PDF Converter
Converts markdown files to PDF with proper formatting including bullet indentation.
Automatically detects and pre-renders Mermaid diagrams to inline SVG.

Usage:
    python3 .kiro/scripts/md2pdf.py <input.md> <output.pdf>

Requirements:
    - Python 3
    - google-chrome (for PDF generation)
    - npx @mermaid-js/mermaid-cli (for Mermaid diagrams, auto-detected)
"""

import re
import sys
import os
import subprocess
import tempfile


def render_mermaid_to_svg(mermaid_code, temp_dir):
    """Render a Mermaid code block to inline SVG using mmdc. Returns SVG string or None."""
    mmd_file = os.path.join(temp_dir, 'diagram.mmd')
    svg_file = os.path.join(temp_dir, 'diagram.svg')

    with open(mmd_file, 'w', encoding='utf-8') as f:
        f.write(mermaid_code)

    # Write a minimal puppeteer config for headless Chrome
    puppeteer_cfg = os.path.join(temp_dir, 'puppeteer.json')
    with open(puppeteer_cfg, 'w') as pf:
        pf.write('{"args":["--no-sandbox","--disable-setuid-sandbox"]}')

    cmd = [
        'npx', '--yes', '@mermaid-js/mermaid-cli',
        '-i', mmd_file,
        '-o', svg_file,
        '-b', 'transparent',
        '--puppeteerConfigFile', puppeteer_cfg
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)  # nosemgrep: dangerous-subprocess-use-audit

    if result.returncode == 0 and os.path.isfile(svg_file):
        with open(svg_file, 'r', encoding='utf-8') as f:
            svg = f.read()
        # Strip XML declaration if present
        svg = re.sub(r'<\?xml[^?]*\?>\s*', '', svg)
        return svg

    print(f"Mermaid render warning: {result.stderr.strip()}", file=sys.stderr)
    return None


def extract_mermaid_blocks(lines):
    """Extract mermaid code blocks from markdown lines.
    Returns list of (start_line_idx, end_line_idx, mermaid_code) tuples."""
    blocks = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith('```mermaid'):
            start = i
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            end = i  # the closing ```
            blocks.append((start, end, ''.join(code_lines)))
        i += 1
    return blocks


def convert_md_to_html(md_file, temp_dir):
    """Convert markdown to HTML with proper list, table, and Mermaid handling."""
    with open(md_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    # Pre-render Mermaid blocks
    mermaid_blocks = extract_mermaid_blocks(lines)
    mermaid_svgs = {}
    for start, end, code in mermaid_blocks:
        svg = render_mermaid_to_svg(code, temp_dir)
        if svg:
            mermaid_svgs[start] = (end, svg)
            print(f"  Rendered Mermaid diagram (lines {start+1}-{end+1})")
        else:
            print(f"  Warning: Mermaid diagram at line {start+1} fell back to code block")

    html_lines = []
    in_code_block = False
    in_table = False
    list_stack = []
    skip_until = -1

    for i, line in enumerate(lines):
        if i <= skip_until:
            continue

        # Check if this line starts a pre-rendered Mermaid block
        if i in mermaid_svgs:
            # Close any open lists/tables first
            while list_stack:
                html_lines.append('</ul>')
                list_stack.pop()
            if in_table:
                html_lines.append('</tbody></table>')
                in_table = False

            end, svg = mermaid_svgs[i]
            html_lines.append(f'<div class="mermaid-diagram">{svg}</div>')
            skip_until = end
            continue

        # Handle code blocks
        if line.strip().startswith('```'):
            if in_code_block:
                html_lines.append('</code></pre>')
                in_code_block = False
            else:
                html_lines.append('<pre><code>')
                in_code_block = True
            continue

        if in_code_block:
            html_lines.append(line.rstrip())
            continue

        # Handle tables
        if '|' in line and line.strip().startswith('|'):
            stripped = line.strip()

            # Check if it's a separator line (|---|---|)
            is_separator = all(c in '|-: ' for c in stripped)

            if not in_table:
                # Start new table
                html_lines.append('<table>')
                in_table = True

                # First row is header
                cells = [cell.strip() for cell in stripped.split('|')[1:-1]]
                html_lines.append('<thead><tr>')
                for cell in cells:
                    html_lines.append(f'<th>{cell}</th>')
                html_lines.append('</tr></thead>')
                html_lines.append('<tbody>')
            elif is_separator:
                # Skip separator line
                continue
            else:
                # Table data row
                cells = [cell.strip() for cell in stripped.split('|')[1:-1]]
                html_lines.append('<tr>')
                for cell in cells:
                    # Handle bold and code in cells
                    cell = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', cell)
                    cell = re.sub(r'`(.*?)`', r'<code>\1</code>', cell)
                    html_lines.append(f'<td>{cell}</td>')
                html_lines.append('</tr>')
            continue
        else:
            # Close table if we were in one
            if in_table:
                html_lines.append('</tbody></table>')
                in_table = False

        # Count leading spaces for indentation level
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        # Handle bullets
        if stripped.startswith('- '):
            level = indent // 2
            content = stripped[2:].strip()

            # Close deeper lists
            while len(list_stack) > level + 1:
                html_lines.append('</ul>')
                list_stack.pop()

            # Open new list if needed
            if len(list_stack) <= level:
                html_lines.append('<ul>')
                list_stack.append(level)

            # Handle bold and code in content
            content = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', content)
            content = re.sub(r'`(.*?)`', r'<code>\1</code>', content)

            html_lines.append(f'<li>{content}</li>')
        else:
            # Close all open lists
            while list_stack:
                html_lines.append('</ul>')
                list_stack.pop()

            # Handle headers
            if stripped.startswith('# '):
                html_lines.append(f'<h1>{stripped[2:].strip()}</h1>')
            elif stripped.startswith('## '):
                html_lines.append(f'<h2>{stripped[3:].strip()}</h2>')
            elif stripped.startswith('### '):
                html_lines.append(f'<h3>{stripped[4:].strip()}</h3>')
            elif stripped.startswith('#### '):
                html_lines.append(f'<h4>{stripped[5:].strip()}</h4>')
            elif stripped.startswith('---'):
                html_lines.append('<hr />')
            elif stripped.startswith('**') and stripped.endswith('**:'):
                content = stripped[2:-3]
                html_lines.append(f'<p><strong>{content}:</strong></p>')
            elif stripped:
                # Regular paragraph
                content = stripped.strip()
                content = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', content)
                content = re.sub(r'`(.*?)`', r'<code>\1</code>', content)
                html_lines.append(f'<p>{content}</p>')
            else:
                html_lines.append('')

    # Close any remaining table
    if in_table:
        html_lines.append('</tbody></table>')

    # Close any remaining lists
    while list_stack:
        html_lines.append('</ul>')
        list_stack.pop()

    return '\n'.join(html_lines)


def create_html_document(body_html, title="Document"):
    """Wrap HTML body with styled document structure."""
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
@page {{ margin: 0.75in; margin-bottom: 1in; }}
body {{ font-family: Arial, sans-serif; font-size: 10pt; line-height: 1.5; color: #333; }}
h1 {{ color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 8px; font-size: 20pt; margin-top: 24pt; page-break-after: avoid; }}
h2 {{ color: #34495e; border-bottom: 2px solid #bdc3c7; padding-bottom: 5px; font-size: 16pt; margin-top: 20pt; page-break-after: avoid; }}
h3 {{ color: #7f8c8d; font-size: 13pt; margin-top: 16pt; page-break-after: avoid; }}
h4 {{ color: #95a5a6; font-size: 11pt; margin-top: 12pt; page-break-after: avoid; }}
p {{ margin: 8pt 0; }}
ul {{ margin: 8pt 0; margin-left: 40px; padding-left: 0; }}
li {{ margin: 4pt 0; padding-left: 10px; }}
ul ul {{ margin-left: 30px; }}
code {{ background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-family: 'Courier New', monospace; font-size: 9pt; }}
pre {{ background: #f8f8f8; padding: 12px; border-radius: 4px; border: 1px solid #ddd; font-size: 8pt; line-height: 1.4; page-break-inside: avoid; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }}
pre code {{ background: none; padding: 0; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }}
table {{ border-collapse: collapse; width: 100%; margin: 12pt 0; font-size: 9pt; }}
th, td {{ border: 1px solid #ddd; padding: 6px 8px; text-align: left; }}
th {{ background-color: #3498db; color: white; font-weight: bold; }}
tr:nth-child(even) {{ background-color: #f9f9f9; }}
strong {{ color: #2c3e50; }}
hr {{ border: none; border-top: 2px solid #bdc3c7; margin: 20pt 0; }}
.mermaid-diagram {{ text-align: center; margin: 16pt 0; page-break-inside: avoid; }}
.mermaid-diagram svg {{ max-width: 100%; height: auto; }}
.page-footer {{ position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 8pt; color: #999; padding: 4px 0; }}
</style>
</head>
<body>
{body_html}
<div class="page-footer">GDIT Internal Proprietary</div>
</body>
</html>"""


def convert_html_to_pdf(html_file, pdf_file):
    """Convert HTML to PDF using Chrome headless."""
    abs_html = os.path.abspath(html_file)
    abs_pdf = os.path.abspath(pdf_file)

    if not os.path.isfile(abs_html):
        print(f"Error: HTML file not found: {abs_html}", file=sys.stderr)
        return False

    cmd = [
        'google-chrome',
        '--headless=new',
        '--disable-gpu',
        f'--print-to-pdf={abs_pdf}',
        '--no-sandbox',
        '--disable-software-rasterizer',
        f'file://{abs_html}'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, shell=False)  # nosemgrep: dangerous-subprocess-use-audit

    if result.returncode != 0 and not os.path.isfile(abs_pdf):
        print(f"Error converting to PDF: {result.stderr}", file=sys.stderr)
        return False

    return os.path.isfile(abs_pdf)


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 .kiro/scripts/md2pdf.py <input.md> <output.pdf>")
        sys.exit(1)

    md_file = sys.argv[1]
    pdf_file = sys.argv[2]

    if not os.path.exists(md_file):
        print(f"Error: Input file not found: {md_file}", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as temp_dir:
        # Convert markdown to HTML (with Mermaid pre-rendering)
        html_body = convert_md_to_html(md_file, temp_dir)

        # Extract title from first H1 or use filename
        title = os.path.splitext(os.path.basename(md_file))[0]
        with open(md_file, 'r', encoding='utf-8') as f:
            for line in f:
                if line.startswith('# '):
                    title = line[2:].strip()
                    break

        html_doc = create_html_document(html_body, title)

        # Write temporary HTML file
        html_file = pdf_file.replace('.pdf', '.html')
        with open(html_file, 'w', encoding='utf-8') as f:
            f.write(html_doc)

        print(f"Generated HTML: {html_file}")

        # Convert HTML to PDF
        if convert_html_to_pdf(html_file, pdf_file):
            print(f"Generated PDF: {pdf_file}")

            # Clean up HTML file
            os.remove(html_file)
            print(f"Cleaned up: {html_file}")
        else:
            print("PDF generation failed", file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
