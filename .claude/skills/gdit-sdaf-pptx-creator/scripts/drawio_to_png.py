#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright"]
# ///
"""Convert .drawio files to PNG using Playwright + draw.io GraphViewer.

Renders diagrams using the official draw.io viewer library with Chromium.
Requires: playwright with chromium (`python3 -m playwright install chromium`).
The viewer JS is bundled at scripts/viewer-static.min.js (auto-downloaded if missing).

Usage:
    python3 drawio_to_png.py <file.drawio> [output.png]
    python3 drawio_to_png.py <directory>  [--output-dir <dir>]
"""

import argparse
import sys
import tempfile
from pathlib import Path

VIEWER_JS = Path(__file__).parent / "viewer-static.min.js"
VIEWER_CDN = "https://viewer.diagrams.net/js/viewer-static.min.js"


def _ensure_viewer():
    """Download viewer JS if not bundled."""
    if not VIEWER_JS.exists():
        print("  Downloading draw.io viewer JS...", file=sys.stderr, flush=True)
        import urllib.request
        urllib.request.urlretrieve(VIEWER_CDN, str(VIEWER_JS))


def drawio_to_png(drawio_path: str, output_path: str, width: int = 1600, timeout: int = 15000) -> bool:
    """Convert a .drawio file to PNG. Returns True on success."""
    from playwright.sync_api import sync_playwright

    _ensure_viewer()
    xml_content = Path(drawio_path).read_text()

    html = (
        '<!DOCTYPE html><html><head>'
        '<style>body{margin:0;padding:0;background:white;overflow:hidden;}</style>'
        '<script src="' + VIEWER_JS.as_uri() + '"></script>'
        '</head><body><div id="graph"></div><script>'
        'var xmlData = ' + repr(xml_content) + ';\n'
        'function tryRender(){'
        '  if(typeof GraphViewer!=="undefined"){'
        '    var c=document.getElementById("graph");'
        '    c.className="mxgraph";'
        '    c.setAttribute("data-mxgraph",'
        '      JSON.stringify({highlight:"#0000ff",nav:false,resize:true,'
        '        toolbar:null,edit:null,xml:xmlData}));'
        '    GraphViewer.createViewerForElement(c);'
        '  } else { setTimeout(tryRender,100); }'
        '}'
        'tryRender();'
        '</script></body></html>'
    )

    with tempfile.NamedTemporaryFile(suffix=".html", mode="w", delete=False) as f:
        f.write(html)
        html_path = f.name

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--allow-file-access-from-files"])
            page = browser.new_page(viewport={"width": width, "height": 1000})
            page.goto(f"file://{html_path}")
            page.wait_for_selector("svg", timeout=timeout)
            page.wait_for_timeout(1500)

            # Crop to diagram bounds
            bbox = page.evaluate("""() => {
                const svg = document.querySelector('svg');
                if (!svg) return null;
                const r = svg.getBoundingClientRect();
                return {x: r.x, y: r.y, width: r.width, height: r.height};
            }""")

            if bbox and bbox["width"] > 10:
                page.screenshot(path=output_path, clip={
                    "x": max(0, bbox["x"] - 10),
                    "y": max(0, bbox["y"] - 10),
                    "width": min(bbox["width"] + 20, width),
                    "height": bbox["height"] + 20,
                })
            else:
                page.screenshot(path=output_path, full_page=True)

            browser.close()

        return Path(output_path).exists() and Path(output_path).stat().st_size > 500
    except Exception as e:
        print(f"  Warning: render failed: {e}", file=sys.stderr)
        return False
    finally:
        Path(html_path).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Export .drawio files to PNG")
    parser.add_argument("path", help=".drawio file or directory")
    parser.add_argument("output", nargs="?", help="Output PNG path (single file mode)")
    parser.add_argument("--output-dir", "-o", help="Output directory (directory mode)")
    args = parser.parse_args()

    source = Path(args.path)
    if source.is_dir():
        files = sorted(source.glob("*.drawio"))
        out_dir = Path(args.output_dir) if args.output_dir else source
    elif source.exists():
        files = [source]
        out_dir = None
    else:
        print(f"ERROR: {source} not found", file=sys.stderr)
        sys.exit(1)

    if not files:
        print("No .drawio files found")
        sys.exit(0)

    for f in files:
        if args.output and len(files) == 1:
            dest = Path(args.output)
        else:
            dest = (out_dir or f.parent) / f"{f.stem}.png"
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"Exporting {f.name} → {dest.name} ...", end=" ", flush=True)
        if drawio_to_png(str(f), str(dest)):
            print(f"✓ ({dest.stat().st_size // 1024} KB)")
        else:
            print("✗ (render failed)")

    print(f"\nDone. {len(files)} file(s) processed.")


if __name__ == "__main__":
    main()
