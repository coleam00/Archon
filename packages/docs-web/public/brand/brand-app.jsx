/* eslint-disable react/prop-types */
// Brand foundation — Archon shield identity.
// The duotone magenta→teal gradient drawn from the shield logo is THE brand.

const { useState, useEffect } = React;
const StandaloneTweaksToggle = window.StandaloneTweaksToggle;

const SECTIONS = [
  { id: "logo",       label: "Logo"        },
  { id: "gradient",   label: "Gradient"    },
  { id: "palette",    label: "Palette"     },
  { id: "type",       label: "Typography"  },
  { id: "components", label: "Components"  },
  { id: "voice",      label: "Voice"       },
  { id: "tokens",     label: "Tokens"      },
];

function Hed({ eyebrow, title, kicker, brandTitle = false }) {
  return (
    <header style={{ marginBottom: 36 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 10 }}>
        {eyebrow}
      </div>
      <h2 className={brandTitle ? "brand-text" : ""} style={{
        margin: 0, fontSize: 36, fontWeight: 600, letterSpacing: "-0.028em", color: "var(--text)",
        lineHeight: 1.1,
      }}>
        {title}
      </h2>
      {kicker && <p style={{ margin: "12px 0 0", fontSize: 15, color: "var(--text-secondary)", maxWidth: 680, lineHeight: 1.6 }}>{kicker}</p>}
    </header>
  );
}

function Tile({ children, dark = false, style = {}, padless = false }) {
  return (
    <div style={{
      background: dark ? "oklch(0.1 0.005 265)" : "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 14,
      overflow: "hidden",
      ...style,
    }}>
      {children}
    </div>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 14 }}>{children}</div>;
}

// ─────────────────────────────────────────────────────────────────────────
// LOGO
// ─────────────────────────────────────────────────────────────────────────

function LogoSection() {
  return (
    <section id="logo" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="01 · Mark"
        title="The shield"
        kicker={<>A shield with a pen nib at its heart. The shield speaks to <em style={{ color: "var(--text)" }}>protection</em> — every workflow is a safe execution boundary. The pen nib speaks to <em style={{ color: "var(--text)" }}>authorship</em> — Archon writes code. The magenta-to-teal gradient is the thread that ties them: where intent meets execution.</>}
      />

      {/* Hero panel */}
      <Tile dark style={{ position: "relative", aspectRatio: "5 / 3", display: "grid", placeItems: "center", marginBottom: 24 }}>
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse at 30% 30%, oklch(0.640 0.295 330 / 0.18) 0%, transparent 55%), radial-gradient(ellipse at 70% 70%, oklch(0.755 0.165 168 / 0.18) 0%, transparent 55%)",
        }}/>
        <ArchonMark size={220}/>
      </Tile>

      {/* Variants */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
        <Tile style={{ padding: "36px 24px 24px" }}>
          <Label>Wordmark</Label>
          <ArchonLockup size={32}/>
        </Tile>
        <Tile style={{ padding: "36px 24px 24px" }}>
          <Label>Lockup with product</Label>
          <ArchonLockup size={28} subtitle="Console"/>
        </Tile>
        <Tile dark style={{ padding: "36px 24px 24px" }}>
          <Label>On dark</Label>
          <ArchonLockup size={32} color="white"/>
        </Tile>
      </div>

      {/* Size scale */}
      <Label>Size scale</Label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 28 }}>
        {[16, 20, 24, 32, 48, 96].map(s => (
          <Tile key={s} style={{ aspectRatio: "1 / 1", display: "grid", placeItems: "center", position: "relative" }}>
            <ArchonMark size={s}/>
            <span className="mono" style={{ position: "absolute", bottom: 8, right: 10, fontSize: 10, color: "var(--text-tertiary)" }}>{s}px</span>
          </Tile>
        ))}
      </div>

      {/* Monochrome */}
      <Label>Monochrome glyph — for masks, favicons, single-color contexts</Label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <Tile style={{ aspectRatio: "1 / 1", display: "grid", placeItems: "center" }}>
          <ArchonGlyph size={80} color="var(--text)"/>
        </Tile>
        <Tile dark style={{ aspectRatio: "1 / 1", display: "grid", placeItems: "center" }}>
          <ArchonGlyph size={80} color="white"/>
        </Tile>
        <Tile style={{ aspectRatio: "1 / 1", display: "grid", placeItems: "center", background: "var(--brand-magenta)" }}>
          <ArchonGlyph size={80} color="white"/>
        </Tile>
        <Tile style={{ aspectRatio: "1 / 1", display: "grid", placeItems: "center", background: "var(--brand-teal)" }}>
          <ArchonGlyph size={80} color="oklch(0.18 0.04 168)"/>
        </Tile>
      </div>

      {/* Don'ts */}
      <div style={{ marginTop: 32 }}>
        <Label>Clear space &amp; misuse</Label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Tile style={{ padding: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", marginBottom: 10 }}>Always keep clearspace ≥ 0.5× mark height</div>
            <div style={{ position: "relative", padding: 32, border: "1px dashed var(--border)", borderRadius: 8, display: "inline-flex" }}>
              <ArchonMark size={64}/>
            </div>
          </Tile>
          <Tile style={{ padding: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", marginBottom: 10 }}>Never: distort · recolor the gradient · place on busy imagery</div>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <div style={{ position: "relative", filter: "grayscale(1)", opacity: 0.5 }}>
                <ArchonMark size={48}/>
                <span style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: "50%", background: "var(--error)", color: "white", fontSize: 10, display: "grid", placeItems: "center", fontWeight: 700 }}>✕</span>
              </div>
              <div style={{ position: "relative", transform: "scaleX(0.7)" }}>
                <ArchonMark size={48}/>
                <span style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: "50%", background: "var(--error)", color: "white", fontSize: 10, display: "grid", placeItems: "center", fontWeight: 700 }}>✕</span>
              </div>
            </div>
          </Tile>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// GRADIENT
// ─────────────────────────────────────────────────────────────────────────

function GradientSection() {
  return (
    <section id="gradient" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="02 · The thread"
        title="One gradient. Used sparingly."
        kicker="The magenta → violet → teal sweep is the strongest brand asset. It's powerful precisely because it's rare. Use it for hero moments: the logo itself, the primary CTA, hero headings, and brand surfaces in marketing. Never as a body fill or page background."
      />

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginBottom: 24 }}>
        <Tile dark style={{ aspectRatio: "16 / 9", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, background: "var(--brand-gradient)" }}/>
        </Tile>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            { hex: "#ED10EC", name: "Magenta", token: "--brand-magenta",  oklch: "oklch(0.640 0.295 330)" },
            { hex: "#8E40C8", name: "Violet",  token: "--brand-violet",   oklch: "oklch(0.560 0.215 305)" },
            { hex: "#06CE94", name: "Teal",    token: "--brand-teal",     oklch: "oklch(0.755 0.165 168)" },
          ].map(s => (
            <Tile key={s.hex} style={{ padding: 14, display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ width: 56, height: 56, borderRadius: 10, background: `var(${s.token})`, flex: "none" }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{s.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{s.hex}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 1 }}>{s.oklch}</div>
              </div>
            </Tile>
          ))}
        </div>
      </div>

      {/* Gradient applications */}
      <Label>Approved applications</Label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <Tile style={{ padding: 20, minHeight: 130 }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Hero text</div>
          <h3 className="brand-text" style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.025em" }}>
            Build with intent.
          </h3>
        </Tile>
        <Tile style={{ padding: 20, minHeight: 130 }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Primary CTA</div>
          <button style={{
            height: 38, padding: "0 18px",
            background: "var(--brand-gradient)",
            color: "white",
            border: "none", borderRadius: 8,
            fontSize: 13, fontWeight: 600,
            boxShadow: "var(--shadow-brand)",
          }}>Start a run →</button>
        </Tile>
        <Tile style={{ padding: 20, minHeight: 130, position: "relative", overflow: "hidden" }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Status rail / divider</div>
          <div style={{ height: 3, borderRadius: 999, background: "var(--brand-gradient)" }}/>
          <div style={{ marginTop: 14, fontSize: 13, color: "var(--text)", fontWeight: 500 }}>Run is live.</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Streaming output…</div>
        </Tile>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PALETTE
// ─────────────────────────────────────────────────────────────────────────

function PaletteSection() {
  const surfaces = [
    { name: "bg",            token: "--bg",            note: "App background" },
    { name: "surface",       token: "--surface",       note: "Cards, rails" },
    { name: "surface-2",     token: "--surface-2",     note: "Inputs, chips" },
    { name: "surface-3",     token: "--surface-3",     note: "Hover, active" },
  ];
  const text = [
    { name: "text",            token: "--text",            note: "Primary copy" },
    { name: "text-secondary",  token: "--text-secondary",  note: "Subtitles, meta" },
    { name: "text-tertiary",   token: "--text-tertiary",   note: "Hints, IDs" },
    { name: "text-quaternary", token: "--text-quaternary", note: "Disabled" },
  ];
  const status = [
    { name: "running", token: "--running", note: "In progress" },
    { name: "success", token: "--success", note: "Approve, OK" },
    { name: "warning", token: "--warning", note: "Caution" },
    { name: "error",   token: "--error",   note: "Failure" },
  ];

  return (
    <section id="palette" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="03 · Palette"
        title="The brand on quiet neutrals"
        kicker="The system relies on a small, controlled set of cool charcoals. Saturated colors only appear when they mean something — brand identity or status."
      />

      <SwatchRow title="Surfaces" items={surfaces}/>
      <SwatchRow title="Text" items={text}/>
      <SwatchRow title="Status" items={status} solid/>
    </section>
  );
}

function SwatchRow({ title, items, solid = false }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12, letterSpacing: "-0.005em" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 12 }}>
        {items.map(it => (
          <Tile key={it.token} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{
              aspectRatio: "3 / 2",
              borderRadius: 8,
              background: `var(${it.token})`,
              border: solid ? "none" : "1px solid var(--divider)",
              boxShadow: solid ? `0 0 0 1px color-mix(in oklch, var(${it.token}) 35%, transparent) inset` : "none",
            }}/>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{it.name}</div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 2 }}>{it.token}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 4 }}>{it.note}</div>
            </div>
          </Tile>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TYPE
// ─────────────────────────────────────────────────────────────────────────

function TypeSection() {
  return (
    <section id="type" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="04 · Type"
        title="Geist for UI · Geist Mono for proof"
        kicker="The product is mostly information — names, IDs, timestamps, errors. Geist (a modern grotesk) handles the prose. Geist Mono earns the right to appear only where columnar alignment or terminal heritage matters: run IDs, durations, file paths, keystrokes."
      />

      <Tile style={{ padding: 36 }}>
        {[
          { tag: "Display",   size: 56, weight: 600, sample: "Build with intent.", note: "Marketing hero", brand: true },
          { tag: "H1",        size: 32, weight: 600, sample: "All projects",               note: "Page titles" },
          { tag: "H2",        size: 22, weight: 600, sample: "Awaiting your decision",     note: "Section headers" },
          { tag: "H3",        size: 16, weight: 600, sample: "What the agent is asking",   note: "Card titles" },
          { tag: "Body",      size: 14, weight: 400, sample: "Composition built and verified. Live preview at $ARTIFACTS_DIR/studio.url.", note: "Default body" },
          { tag: "Small",     size: 12, weight: 400, sample: "leex279/remotion-video-test · 2m ago", note: "Meta, captions" },
          { tag: "Eyebrow",   size: 11, weight: 600, sample: "WAITING FOR APPROVAL", note: "Tracking 0.06em", upper: true },
          { tag: "Mono",      size: 12, weight: 500, sample: "a3f12c8e · 00:12:04 · /api/runs", note: "IDs, durations, paths", mono: true },
        ].map((t, i) => (
          <div key={t.tag} style={{ display: "grid", gridTemplateColumns: "84px 1fr 200px", alignItems: "baseline", gap: 24, padding: "14px 0", borderTop: i > 0 ? "1px solid var(--divider)" : "none" }}>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{t.tag}</span>
            <span
              className={`${t.mono ? "mono" : ""} ${t.brand ? "brand-text" : ""}`}
              style={{
                fontSize: t.size,
                fontWeight: t.weight,
                color: t.brand ? "transparent" : "var(--text)",
                letterSpacing: t.upper ? "0.06em" : (t.size >= 22 ? "-0.025em" : "-0.005em"),
                textTransform: t.upper ? "uppercase" : "none",
                lineHeight: t.size > 24 ? 1.1 : 1.4,
              }}
            >
              {t.sample}
            </span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              {t.size}px · {t.weight}{t.mono ? " · mono" : ""}
            </span>
          </div>
        ))}
      </Tile>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────────────────────────────────

function ComponentsSection() {
  return (
    <section id="components" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="05 · Components"
        title="The core surface kit"
        kicker="Every UI is built from these primitives. The brand gradient lives only on the primary CTA — quieter actions stay solid or ghosted."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
        <Tile style={{ padding: 20 }}>
          <Label>Buttons</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <BrandBtn variant="primary">Start run</BrandBtn>
            <BrandBtn variant="success">Approve</BrandBtn>
            <BrandBtn variant="ghost">Cancel</BrandBtn>
            <BrandBtn variant="outline">Open run</BrandBtn>
            <BrandBtn variant="danger-ghost">Reject</BrandBtn>
          </div>
        </Tile>

        <Tile style={{ padding: 20 }}>
          <Label>Status pills</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {["running", "paused", "completed", "failed"].map(s => (
              <StatusPillBrand key={s} status={s}/>
            ))}
          </div>
        </Tile>

        <Tile style={{ padding: 20 }}>
          <Label>Input</Label>
          <input
            placeholder="Search workflow, project, run id"
            style={{
              width: "100%", height: 38,
              padding: "0 12px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 13,
              color: "var(--text)",
              outline: "none",
            }}
          />
        </Tile>

        <Tile style={{ padding: 20 }}>
          <Label>Origin badges</Label>
          <div style={{ display: "flex", gap: 8 }}>
            <OriginBadgeBrand origin="CLI"/>
            <OriginBadgeBrand origin="Web"/>
          </div>
        </Tile>

        <Tile style={{ padding: 24, gridColumn: "span 2", display: "flex", alignItems: "center", gap: 24 }}>
          <ArchonMark size={48}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Run · stripe with brand bar</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>The gradient appears as a 3px left rail on cards that need attention — paused runs awaiting approval, breaking news.</div>
          </div>
          <div style={{ width: 3, alignSelf: "stretch", borderRadius: 999, background: "var(--brand-gradient)" }}/>
        </Tile>
      </div>
    </section>
  );
}

function BrandBtn({ children, variant = "ghost" }) {
  const styles = {
    primary: { background: "var(--brand-gradient)", color: "white", border: "none", boxShadow: "var(--shadow-brand)" },
    success: { background: "var(--success)", color: "oklch(0.15 0.04 168)", border: "none" },
    ghost:   { background: "transparent", color: "var(--text-secondary)", border: "1px solid transparent" },
    outline: { background: "transparent", color: "var(--text)", border: "1px solid var(--border)" },
    "danger-ghost": { background: "transparent", color: "var(--error)", border: "1px solid color-mix(in oklch, var(--error) 35%, transparent)" },
  }[variant];
  return (
    <button style={{
      height: 36, padding: "0 16px",
      borderRadius: 8,
      fontSize: 13, fontWeight: variant === "primary" || variant === "success" ? 600 : 500,
      ...styles,
    }}>{children}</button>
  );
}

function StatusPillBrand({ status }) {
  const map = {
    running:   { fg: "var(--running)", label: "Running",   pulse: true },
    paused:    { fg: "var(--brand-magenta)", label: "Waiting",   pulse: true },
    completed: { fg: "var(--success)", label: "Completed", pulse: false },
    failed:    { fg: "var(--error)",   label: "Failed",    pulse: false },
  }[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      height: 24, padding: "0 10px",
      borderRadius: 999,
      background: `color-mix(in oklch, ${map.fg} 14%, transparent)`,
      color: map.fg,
      fontSize: 11.5, fontWeight: 500,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: map.fg, animation: map.pulse ? "pulse-dot 1.6s ease-in-out infinite" : "none" }}/>
      {map.label}
    </span>
  );
}

function OriginBadgeBrand({ origin }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        height: 22, padding: "0 8px",
        borderRadius: 4,
        fontSize: 10.5, fontWeight: 500, letterSpacing: "0.04em",
        background: "var(--surface-2)",
        color: "var(--text-tertiary)",
        border: "1px solid var(--border)",
      }}
    >
      {origin}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// VOICE
// ─────────────────────────────────────────────────────────────────────────

function VoiceSection() {
  return (
    <section id="voice" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="06 · Voice"
        title="How Archon talks"
        kicker="Direct, plain, technically honest. Archon explains what it did, what it's waiting for, and what it needs from you — without flattery, exclamation points, or marketing fog."
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Tile style={{ padding: 22, borderLeft: "3px solid var(--success)" }}>
          <Label>Do</Label>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: "var(--text)", lineHeight: 1.7 }}>
            <li>Composition built and verified. Reply <code className="mono">/approve</code> to render.</li>
            <li>Failed at <code className="mono">step 4 · run-tests</code> after 2m 14s.</li>
            <li>Nothing running right now.</li>
            <li>Archon is asking a question.</li>
          </ul>
        </Tile>
        <Tile style={{ padding: 22, borderLeft: "3px solid var(--error)" }}>
          <Label>Don't</Label>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <li>🚀 Awesome! Your composition is ready! ✨</li>
            <li>Oops, something went wrong.</li>
            <li>No active workflows in the system at this time.</li>
            <li>The AI needs your input.</li>
          </ul>
        </Tile>
      </div>

      <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { word: "Run",      not: "Job · Task · Execution"   },
          { word: "Project",  not: "Repo · App · Workspace"   },
          { word: "Workflow", not: "Pipeline · Stage · Flow"  },
          { word: "Worktree", not: "Branch · Checkout"        },
        ].map(p => (
          <Tile key={p.word} style={{ padding: 18 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)" }}>{p.word}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 6 }}>not <span style={{ textDecoration: "line-through" }}>{p.not}</span></div>
          </Tile>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TOKENS
// ─────────────────────────────────────────────────────────────────────────

function TokensSection() {
  const tokens = [
    { name: "--bg",             value: "oklch(0.145 0.006 265)" },
    { name: "--surface",        value: "oklch(0.175 0.007 265)" },
    { name: "--surface-2",      value: "oklch(0.205 0.009 265)" },
    { name: "--border",         value: "oklch(0.275 0.012 265)" },
    { name: "--text",           value: "oklch(0.975 0.004 265)" },
    { name: "--text-secondary", value: "oklch(0.745 0.014 265)" },
    { name: "--brand-magenta",  value: "oklch(0.640 0.295 330)" },
    { name: "--brand-violet",   value: "oklch(0.560 0.215 305)" },
    { name: "--brand-teal",     value: "oklch(0.755 0.165 168)" },
    { name: "--accent",         value: "var(--brand-magenta)"  },
    { name: "--running",        value: "oklch(0.720 0.155 245)" },
    { name: "--success",        value: "var(--brand-teal)"      },
    { name: "--warning",        value: "oklch(0.800 0.140 85)"  },
    { name: "--error",          value: "oklch(0.680 0.215 18)"  },
  ];
  const radii = [
    { name: "sm", value: 4  },
    { name: "md", value: 6  },
    { name: "lg", value: 8  },
    { name: "xl", value: 12 },
    { name: "2xl", value: 16 },
  ];
  return (
    <section id="tokens" style={{ paddingBottom: 96 }}>
      <Hed
        eyebrow="07 · Tokens"
        title="The numbers"
        kicker="All values are oklch — perceptually uniform, predictable when shifted, and convertible to light mode by flipping the L channel."
      />

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <Tile padless style={{ padding: 0 }}>
          <header style={{ padding: "14px 20px", borderBottom: "1px solid var(--divider)" }}>
            <Label>Color tokens</Label>
            <div style={{ marginTop: -10 }}/>
          </header>
          <div>
            {tokens.map((t, i) => (
              <div key={t.name} style={{ display: "grid", gridTemplateColumns: "20px 1fr 1fr", alignItems: "center", gap: 12, padding: "10px 20px", borderTop: i > 0 ? "1px solid var(--divider)" : "none" }}>
                <span style={{ width: 16, height: 16, borderRadius: 4, background: `var(${t.name})`, border: "1px solid var(--divider)" }}/>
                <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{t.name}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "right" }}>{t.value}</span>
              </div>
            ))}
          </div>
        </Tile>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Tile style={{ padding: 20 }}>
            <Label>Radii</Label>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
              {radii.map(r => (
                <div key={r.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 48, height: 48, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: r.value }}/>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{r.value}px</span>
                </div>
              ))}
            </div>
          </Tile>

          <Tile style={{ padding: 20 }}>
            <Label>Spacing</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[4, 8, 12, 16, 20, 24, 32].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="mono" style={{ width: 36, fontSize: 11, color: "var(--text-tertiary)" }}>{s}px</span>
                  <span style={{ height: 6, width: s * 4, background: "var(--brand-gradient)", borderRadius: 2 }}/>
                </div>
              ))}
            </div>
          </Tile>

          <Tile style={{ padding: 20 }}>
            <Label>Motion</Label>
            <div className="mono" style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-secondary)" }}>
              <div>fast · <span style={{ color: "var(--text)" }}>120ms</span> · cubic-bezier(.4, 0, .2, 1)</div>
              <div>base · <span style={{ color: "var(--text)" }}>180ms</span> · cubic-bezier(.16, 1, .3, 1)</div>
              <div>slow · <span style={{ color: "var(--text)" }}>360ms</span> · cubic-bezier(.16, 1, .3, 1)</div>
            </div>
          </Tile>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SHELL
// ─────────────────────────────────────────────────────────────────────────

const BRAND_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "magenta"
}/*EDITMODE-END*/;

const BRAND_ACCENTS = [
  { id: "magenta", label: "Magenta", swatch: "oklch(0.640 0.295 330)" },
  { id: "teal",    label: "Teal",    swatch: "oklch(0.755 0.165 168)" },
  { id: "violet",  label: "Violet",  swatch: "oklch(0.560 0.215 305)" },
  { id: "mono",    label: "Mono",    swatch: "linear-gradient(135deg, oklch(0.95 0.005 265) 0%, oklch(0.65 0.005 265) 100%)" },
];

function BrandAccentSwatches({ value, onChange }) {
  const active = BRAND_ACCENTS.find(o => o.id === value) ?? BRAND_ACCENTS[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 11.5, color: "rgba(41,38,27,.72)" }}>
        <span style={{ fontWeight: 500 }}>Color</span>
        <span style={{ color: "rgba(41,38,27,.5)" }}>{active.label}</span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {BRAND_ACCENTS.map(o => {
          const isActive = o.id === value;
          return (
            <button key={o.id} type="button" onClick={() => onChange(o.id)} title={o.label}
              style={{
                flex: 1, height: 32, padding: 0,
                border: isActive ? "2px solid rgba(41,38,27,.85)" : "1px solid rgba(0,0,0,.12)",
                borderRadius: 8, background: o.swatch, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              {isActive && (
                <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                  <path d="M3 7.2 5.8 10 11 4.2" fill="none" strokeWidth="2.4"
                    strokeLinecap="round" strokeLinejoin="round" stroke="rgba(0,0,0,.78)"/>
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BrandApp() {
  const [t, setTweak] = useTweaks(BRAND_DEFAULTS);
  const [active, setActive] = useState("logo");

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = t.theme;
    root.dataset.accent = t.accent;
  }, [t.theme, t.accent]);

  useEffect(() => {
    const els = SECTIONS.map(s => document.getElementById(s.id)).filter(Boolean);
    const io = new IntersectionObserver(entries => {
      const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id);
    }, { rootMargin: "-30% 0px -60% 0px" });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div style={{ minHeight: "100vh" }}>
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        height: 56,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 28px",
        borderBottom: "1px solid var(--divider)",
        background: "color-mix(in oklch, var(--bg) 80%, transparent)",
        backdropFilter: "blur(8px)",
      }}>
        <ArchonLockup size={22} subtitle="Brand"/>
      </header>

      <div style={{ display: "flex", maxWidth: 1320, margin: "0 auto" }}>
        <aside style={{
          position: "sticky", top: 56, alignSelf: "flex-start",
          width: 220, flex: "none",
          padding: "40px 16px 40px 28px",
          height: "calc(100vh - 56px)",
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 14, paddingLeft: 10 }}>
            Sections
          </div>
          <nav style={{ display: "flex", flexDirection: "column" }}>
            {SECTIONS.map((s, i) => {
              const isActive = active === s.id;
              return (
                <a key={s.id} href={`#${s.id}`} style={{
                  position: "relative",
                  display: "flex", alignItems: "center", gap: 10,
                  height: 32, padding: "0 10px",
                  fontSize: 13,
                  color: isActive ? "var(--text)" : "var(--text-secondary)",
                  fontWeight: isActive ? 500 : 400,
                  textDecoration: "none",
                  borderRadius: 6,
                  background: isActive ? "var(--surface-2)" : "transparent",
                }}>
                  {isActive && <span style={{ position: "absolute", left: -2, top: 6, bottom: 6, width: 2, borderRadius: 2, background: "var(--brand-gradient)" }}/>}
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>0{i + 1}</span>
                  {s.label}
                </a>
              );
            })}
          </nav>

          <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--divider)", display: "flex", flexDirection: "column", gap: 12, paddingLeft: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Theme
            </div>
            <div style={{ display: "flex", gap: 4, padding: 3, background: "var(--surface-2)", borderRadius: 8 }}>
              {["dark", "light"].map(m => (
                <button key={m} onClick={() => setTweak("theme", m)} style={{
                  flex: 1, height: 26,
                  background: t.theme === m ? "var(--surface)" : "transparent",
                  border: "none", borderRadius: 5,
                  color: t.theme === m ? "var(--text)" : "var(--text-secondary)",
                  fontSize: 11.5, fontWeight: 500, textTransform: "capitalize",
                }}>{m}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 6 }}>
              Accent
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {BRAND_ACCENTS.map(a => {
                const isOn = t.accent === a.id;
                return (
                  <button key={a.id} onClick={() => setTweak("accent", a.id)} aria-label={a.label} title={a.label} style={{
                    width: 28, height: 28,
                    borderRadius: 8,
                    background: a.swatch,
                    border: isOn ? "2px solid var(--text)" : "1px solid var(--border)",
                    cursor: "pointer", padding: 0,
                  }}/>
                );
              })}
            </div>
          </div>
        </aside>

        <main style={{ flex: 1, minWidth: 0, padding: "40px 28px 100px" }}>
          {/* HERO */}
          <div style={{ marginBottom: 72, position: "relative" }}>
            <div style={{
              position: "absolute", inset: "-40px -28px 0",
              background: "radial-gradient(ellipse at 20% 0%, oklch(0.640 0.295 330 / 0.10) 0%, transparent 50%), radial-gradient(ellipse at 90% 30%, oklch(0.755 0.165 168 / 0.10) 0%, transparent 55%)",
              pointerEvents: "none", zIndex: -1,
            }}/>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
              <ArchonMark size={56}/>
              <div style={{ width: 1, height: 36, background: "var(--border)" }}/>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", letterSpacing: "0.12em", textTransform: "uppercase" }}>Brand foundation</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>v1.0 · 2026</div>
              </div>
            </div>
            <h1 style={{ margin: 0, fontSize: 64, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.02, color: "var(--text)", maxWidth: 820 }}>
              The system behind <span className="brand-text">Archon</span>.
            </h1>
            <p style={{ margin: "20px 0 0", fontSize: 17, color: "var(--text-secondary)", maxWidth: 680, lineHeight: 1.55 }}>
              A precise, dark-first visual identity for AI-driven engineering workflows. The shield protects. The pen writes. The gradient — magenta to teal — is the thread between intent and execution.
            </p>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 32 }}>
              <a href="#logo" style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                height: 40, padding: "0 18px",
                background: "var(--brand-gradient)",
                color: "white",
                border: "none", borderRadius: 10,
                fontSize: 14, fontWeight: 600, textDecoration: "none",
                boxShadow: "var(--shadow-brand)",
              }}>
                Start the tour →
              </a>
              <a href={window.getBuddyHref ? window.getBuddyHref("console") : "Archon Console.html"} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                height: 40, padding: "0 16px",
                background: "transparent",
                color: "var(--text)", textDecoration: "none",
                border: "1px solid var(--border)",
                borderRadius: 10, fontSize: 14, fontWeight: 500,
              }}>
                See the Console
              </a>
            </div>
          </div>

          <LogoSection/>
          <GradientSection/>
          <PaletteSection/>
          <TypeSection/>
          <ComponentsSection/>
          <VoiceSection/>
          <TokensSection/>

          <footer style={{
            marginTop: 40, paddingTop: 24,
            borderTop: "1px solid var(--divider)",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            fontSize: 12, color: "var(--text-tertiary)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <ArchonGlyph size={16} color="var(--text-tertiary)"/>
              <span className="mono">archon · brand v1.0</span>
            </div>
            <span>Maintained by the platform team</span>
          </footer>
        </main>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme"/>
        <TweakRadio label="Mode" value={t.theme} onChange={v => setTweak("theme", v)}
          options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]}/>
        <TweakSection label="Accent"/>
        <BrandAccentSwatches value={t.accent} onChange={v => setTweak("accent", v)}/>
      </TweaksPanel>
      <StandaloneTweaksToggle/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<BrandApp />);
