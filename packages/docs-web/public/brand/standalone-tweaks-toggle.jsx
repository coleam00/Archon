/* eslint-disable react/prop-types */
// Standalone-only Tweaks toggle.
//
// In the design environment, the host iframe shows a "Tweaks" toggle in its
// toolbar once a page posts __edit_mode_available. When the bundled file is
// opened directly (no host), that toggle never appears — so we render our
// own floating button that posts the same activation message.
//
// We render unconditionally: in the design env it's a harmless second way
// to open the panel; standalone, it's the only way.

function StandaloneTweaksToggle() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onMsg = (e) => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode')   setOpen(true);
      else if (t === '__deactivate_edit_mode' || t === '__edit_mode_dismissed') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  if (open) return null; // panel has its own close button

  const toggle = () => {
    window.postMessage({ type: '__activate_edit_mode' }, '*');
    setOpen(true);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Open tweaks"
      title="Open tweaks"
      style={{
        position: "fixed",
        right: 20, bottom: 20,
        zIndex: 2147483645,
        display: "inline-flex", alignItems: "center", gap: 8,
        height: 40, padding: "0 14px 0 12px",
        background: "var(--surface, #1a1d24)",
        color: "var(--text, #fff)",
        border: "1px solid var(--border, rgba(255,255,255,.12))",
        borderRadius: 999,
        boxShadow: "0 10px 30px -8px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.02) inset",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12.5, fontWeight: 500,
        letterSpacing: "-0.005em",
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="6" cy="6" r="2"/>
        <path d="M6 8v12M6 4V2"/>
        <circle cx="12" cy="14" r="2"/>
        <path d="M12 16v4M12 12V2"/>
        <circle cx="18" cy="9" r="2"/>
        <path d="M18 11v9M18 7V2"/>
      </svg>
      Tweaks
    </button>
  );
}

window.StandaloneTweaksToggle = StandaloneTweaksToggle;

// Cross-link resolver — in the dev environment, files live as
// "Archon Console.html" + "Brand.html". In the bundled standalones they
// live as "Archon Console — Standalone.html" + "Archon Brand — Standalone.html".
// We pick the right href by sniffing the current pathname.
function getBuddyHref(target /* "console" | "brand" */) {
  const isStandalone = (() => {
    try {
      return /Standalone/i.test(decodeURIComponent(window.location.pathname));
    } catch (e) { return false; }
  })();
  if (target === "console") {
    return isStandalone ? "Archon Console — Standalone.html" : "Archon Console.html";
  }
  return isStandalone ? "Archon Brand — Standalone.html" : "Brand.html";
}

window.getBuddyHref = getBuddyHref;
