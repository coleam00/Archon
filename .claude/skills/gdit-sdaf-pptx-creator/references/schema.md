# YAML Content Schema

## Presentation Settings

```yaml
presentation:
  title: "Deck Title"                    # Required — used for default output filename
  subtitle: "Optional subtitle"
  author: "Author Name"
  date: "April 2026"
  theme:                                 # All optional — defaults shown
    primary: "#1B2A4A"                   # Header bars, dark backgrounds
    secondary: "#2E5C9A"                 # Column backgrounds, supporting color
    accent: "#E86C00"                    # Metric values, emphasis, accent bars
    background: "#FFFFFF"                # Slide background
    text: "#333333"                      # Body text
    muted: "#666666"                     # Footers, secondary text
    light_bg: "#F0F2F5"                  # Card/grid cell backgrounds
  footer: "Company | Topic | Label"      # Appears bottom-left on non-title slides
```

## Slide Types

### title

Opening or closing slide with centered text on dark background.

```yaml
- type: title
  title: "Main Title"                    # Required
  subtitle: "Subtitle line"             # Optional — appears below title
  tagline: "Short tagline"             # Optional — smaller text below subtitle
  bottom_text: "Date or org line"       # Optional — near bottom
```

### content

Most common slide. Header bar + bullet list.

```yaml
- type: content
  title: "Slide Title"                   # Required — appears in header bar
  intro: "Intro paragraph"             # Optional — text below header before bullets
  body:                                  # Required — bullet list
    - "First bullet point"
    - "Second bullet point"
```

### two-column

Side-by-side comparison. Each column can be light or dark style.

```yaml
- type: two-column
  title: "Slide Title"                   # Required
  intro: "Optional intro text"          # Optional
  left:
    heading: "Left Column"              # Optional
    style: light                         # light (gray bg, dark text) | dark (primary bg, white text)
    items:                               # Optional
      - "Item 1"
      - "Item 2"
    footer_text: "Bottom text"          # Optional — appears at bottom of column
  right:
    heading: "Right Column"
    style: dark
    items:
      - "Item 1"
    footer_text: "Emphasis text"
```

### metrics

Metric boxes across the top + optional heading and bullet list below.

```yaml
- type: metrics
  title: "Slide Title"                   # Required
  metrics:                               # Required — 1-6 metric boxes
    - value: "91.3%"                     # Display value
      label: "Time Savings"             # Label below value
      color: accent                      # accent | green | red | primary | #hex
    - value: "0%"
      label: "Overruns"
      color: green
  heading: "Section heading"            # Optional — bold text above bullets
  body:                                  # Optional — bullet list
    - "Supporting point"
```

### grid

N-column grid of cells. Auto-wraps rows. Good for framework comparisons.

```yaml
- type: grid
  title: "Slide Title"                   # Required
  columns: 3                             # Number of columns (default: 3)
  intro: "Optional intro text"          # Optional
  cells:                                 # Required — list of cells
    - heading: "Cell Title"             # Optional
      items:                             # Optional
        - "Item 1"
        - "Item 2"
    - heading: "Another Cell"
      items:
        - "Item 1"
  bottom_text: "Footer text"            # Optional
```

### call-to-action

Closing slide with column highlights on dark background.

```yaml
- type: call-to-action
  title: "Closing Title"                 # Required
  columns:                               # Optional — highlight columns
    - heading: "Column 1"
      items:
        - "Key point 1"
        - "Key point 2"
    - heading: "Column 2"
      items:
        - "Key point 1"
  closing: "Final statement"            # Optional — centered below columns
  bottom_text: "Tagline"               # Optional — bottom of slide
```

## Speaker Notes

Any slide type supports an optional `notes` field containing presenter notes. These are visible only in presenter view (not on the projected slide).

```yaml
- type: content
  title: "Slide Title"
  body:
    - "Visible bullet"
  notes: "Talk track for the presenter. This text appears in the notes pane in PowerPoint/LibreOffice/Google Slides presenter view."
```

Notes are plain text (no markdown formatting). They appear in the slide's notes frame below the slide thumbnail in editing view, and in the presenter console during presentation.

## Color References

Colors can be specified as:
- Theme names: `primary`, `secondary`, `accent`, `background`, `text`, `muted`, `light_bg`
- Built-in names: `green`, `red`, `white`, `black`
- Hex values: `"#E86C00"` (must be quoted in YAML)

## Appendix: Diagrams

Add an `appendix` section at the top level (alongside `presentation` and `slides`) to auto-generate appendix slides from diagram files.

```yaml
appendix:
  diagrams:
    - file: "docs/architecture/component-overview.drawio"
      title: "Component Overview"              # Optional — defaults to filename stem
      image: "docs/architecture/component-overview.png"  # Optional — pre-exported image
      description: "High-level architecture"   # Optional — shown if no image available
    - file: "docs/architecture/workflow.drawio"
      image: "docs/architecture/workflow.png"
```

### Image Resolution Order

For each diagram entry, the converter looks for an image to embed in this order:

1. Explicit `image` field — use this path directly
2. Matching `.png` next to the `.drawio` file (e.g., `overview.drawio` → `overview.png`)
3. Matching `.svg` or `.jpg` next to the `.drawio` file
4. **Fallback**: extract text labels from .drawio XML (text-only summary)

### Exporting .drawio to PNG

The converter embeds images — it does not render .drawio files. Export your diagrams first:

- **draw.io desktop**: File → Export as → PNG (recommended: 2x scale, transparent background)
- **draw.io web** (app.diagrams.net): File → Export as → PNG
- **CLI** (if draw.io desktop installed): `drawio -x -f png -o output.png input.drawio`

Place the exported PNG next to the .drawio file with the same name, and the converter picks it up automatically.

### Direct Slide Type

You can also use the `diagram` slide type directly in the `slides` list:

```yaml
slides:
  # ... main slides ...
  - type: diagram
    title: "Architecture Overview"
    file: "docs/architecture/overview.drawio"    # Path to .drawio file
    image: "docs/architecture/overview.png"      # Pre-exported image (preferred)
    description: "Fallback text if no image"     # Optional
```
