# Brand foundation source

Live at https://archon.diy/brand/foundation.html. Embedded into the docs Brand page via iframe (see `packages/docs-web/src/content/docs/brand/index.md`).

These are the original Penpot-exported source files — plain JSX compiled in the browser by Babel-standalone. No build step, no bundling. **To change the brand sheet, edit these files directly and refresh the page.**

| File | Owns |
| --- | --- |
| `foundation.html` | HTML shell. Loads React + Babel from CDN, wires up the JSX scripts, and applies our docs-site overrides (hides the Tweaks toggle). |
| `brand-app.jsx` | The full brand sheet: header, sections, gradient swatches, type scale, do's & don'ts. Where you edit copy and section layout. |
| `logo.jsx` | `ArchonMark`, `ArchonGlyph`, `ArchonLockup` components. SVG path data lives here. |
| `app.css` | Design tokens (oklch palette, surfaces, typography). Where you edit colors and spacing. |
| `tweaks-panel.jsx` | Generic tweak-panel widget shipped with Penpot exports. Brand sheet uses `useTweaks` for live customisation in the editor; the floating toggle is hidden on archon.diy via `foundation.html`. |
| `standalone-tweaks-toggle.jsx` | Companion floating button for `tweaks-panel.jsx`. Hidden on archon.diy. |
| `assets/archon-logo.png` | Rasterised logo fallback (the inline SVGs in `logo.jsx` are the canonical mark). |

## Local customisations

We carry exactly one delta on top of the upstream Penpot export:

- `brand-app.jsx`: removed the top-right "Console →" cross-link in the page header, since the sibling "Archon Console" doc isn't published here.

If you re-export from Penpot, re-apply that single change (or accept the cross-link).
