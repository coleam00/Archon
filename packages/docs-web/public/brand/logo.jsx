/* eslint-disable react/prop-types */
// Archon logo — the official shield mark. Uses the source PNG as the
// canonical rendering (it carries the multi-color gradient cleanly at any
// size), with an SVG glyph variant for single-color contexts (favicons,
// monochrome lockups, embedded indicators).
//
// When this file is loaded inside a standalone-HTML bundle, the bundler
// replaces the PNG with a blob URL exposed at window.__resources.archonLogo
// (registered via a <meta name="ext-resource-dependency"> tag). The helper
// below picks that up at render time so the same component works both in
// dev (relative path) and standalone (blob URL).
function getArchonLogoSrc() {
  if (typeof window !== "undefined" && window.__resources?.archonLogo) {
    return window.__resources.archonLogo;
  }
  return "assets/archon-logo.png";
}

// Multi-color logo (the brand mark) — renders the PNG at any size.
function ArchonMark({ size = 22, alt = "Archon" }) {
  return (
    <img
      src={getArchonLogoSrc()}
      width={size}
      height={size}
      alt={alt}
      style={{
        display: "block",
        flex: "none",
        // Preserve the PNG's intrinsic colors against any background; the
        // logo is designed to read on both dark + light surfaces.
        userSelect: "none",
      }}
      draggable={false}
    />
  );
}

// Monochrome glyph — for places that demand a single foreground color
// (cursor masks, favicons, very small UI). Captures the shield silhouette
// and the inner pen-nib mark in one path-family. Not pixel-perfect; the
// PNG is canon.
function ArchonGlyph({ size = 22, color = "currentColor" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      {/* Shield outline */}
      <path
        d="M12 2.2 C9.4 2.2 5.6 2.7 4 3.6 L4 11 C4 15.8 7.5 19.8 12 21.8 C16.5 19.8 20 15.8 20 11 L20 3.6 C18.4 2.7 14.6 2.2 12 2.2 Z"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Pen nib — diamond at top */}
      <path d="M12 5.6 L13.4 7 L12 8.4 L10.6 7 Z" stroke={color} strokeWidth="1.1" strokeLinejoin="round"/>
      {/* Pen body — curves cradling a center point */}
      <path d="M12 8.4 L12 11.4" stroke={color} strokeWidth="1.1" strokeLinecap="round"/>
      <path d="M9 11.5 C9 13.3 10.2 14.2 12 14.2 C13.8 14.2 15 13.3 15 11.5" stroke={color} strokeWidth="1.1" strokeLinecap="round"/>
      {/* Center dot */}
      <circle cx="12" cy="14.2" r="0.65" fill={color}/>
      {/* Tail down to bottom point */}
      <path d="M12 14.6 L12 19.4" stroke={color} strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  );
}

function ArchonLockup({ size = 22, color = "currentColor", subtitle = null, useGlyph = false }) {
  const Mark = useGlyph ? ArchonGlyph : ArchonMark;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Mark size={size} color={color} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          style={{
            fontSize: size * 0.78,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color,
            lineHeight: 1,
          }}
        >
          Archon
        </span>
        {subtitle && (
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              borderLeft: "1px solid var(--border)",
              paddingLeft: 10,
              lineHeight: 1,
            }}
          >
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}

window.ArchonMark = ArchonMark;
window.ArchonGlyph = ArchonGlyph;
window.ArchonLockup = ArchonLockup;
window.getArchonLogoSrc = getArchonLogoSrc;
