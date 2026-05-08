# Conflict Coach — Design Document
**Version 1.0 · April 2026 · Applied Labs (aplab.ai)**

> This document defines the visual language, interaction patterns, navigation, and screen-by-screen UX for Conflict Coach v1. It pairs with the PRD (product intent) and Tech Spec (how it works under the hood).

---

## 1. Design Principles

Five principles govern every design decision in Conflict Coach. When in doubt, defer to them in this order:

### 1.1 Calm over Clever
The product exists because the people using it are stressed, frustrated, or hurt. The interface must feel like a deep breath, not a productivity app. No aggressive colors, no gamification, no celebration animations on "conflict resolved." Reserved, considered, gentle.

### 1.2 The Human is the Decision-Maker
Every AI output is a suggestion. The user sends the message, marks the phase complete, confirms the closure. The UI must make the human's agency visually unmistakable — Send is always a human action, never automatic.

### 1.3 Privacy is Visible, Not Implied
If a screen contains private data, the screen says so. If the other party can't see something, the UI labels it "Private to you." Trust is earned by showing the seams, not hiding them.

### 1.4 One Primary Action per Screen
In a conflict, decision fatigue is already high. Each screen has one clear next step. Secondary actions are available but visually subordinated.

### 1.5 Presence over Polish
Real-time updates, streaming text, subtle activity indicators — these do more for trust than any amount of decorative polish. Invest visual budget in the moments of live interaction.

---

## 2. Visual Language

### 2.1 Color Palette

The palette is deliberately muted and warm. No saturated blues or reds. The default theme is light with a soft off-white canvas.

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-canvas` | `#FAF8F5` | Page background — warm off-white, low eye strain |
| `--bg-surface` | `#FFFFFF` | Cards, chat bubbles, panels |
| `--bg-surface-subtle` | `#F3EFE9` | Hover states, subtle sections |
| `--text-primary` | `#1F1D1A` | Body text |
| `--text-secondary` | `#5C5952` | Labels, metadata |
| `--text-tertiary` | `#8A8680` | Timestamps, hints |
| `--accent` | `#6B8E7F` | Primary actions — a sage green, calming, not commanding |
| `--accent-hover` | `#5A7A6C` | Primary hover |
| `--accent-subtle` | `#DCE7E0` | Accent backgrounds (mention chips, coach messages) |
| `--danger` | `#B5594D` | Destructive actions — muted terracotta, not red |
| `--danger-subtle` | `#F2DCD8` | Danger backgrounds |
| `--warning` | `#B58B4D` | Inflammatory-content coach intervention highlight |
| `--border-default` | `#E5E0D8` | Hairline borders, dividers |
| `--border-strong` | `#CBC4B8` | Input borders, strong dividers |
| `--coach-accent` | `#8B7AB5` | Coach AI identity — soft dusty lavender, distinct from user |
| `--private-tint` | `#F0E9E0` | Background tint for "this is private to you" panels |

Dark mode mirrors the palette with inverted luminance, preserving the same warm, low-saturation feeling.

### 2.2 Typography

- **Primary font:** Inter (variable) — 400 / 500 / 600 weights
- **Body:** 15px / 1.6 line-height (chat bubbles: 16px for readability)
- **Chat timestamps:** 12px, `--text-tertiary`
- **Headings:** 500 weight for H1/H2 (not 700) — this is not a marketing page, bold headings feel shouty
- **Mono:** JetBrains Mono (for invite links, audit log IDs)

### 2.3 Spacing & Layout
- 8px base grid. Common paddings: 8, 16, 24, 32, 48.
- Content max-width: 720px for reading-heavy screens (case forms, synthesis). 1080px for joint chat (more breathing room between message columns).
- Mobile breakpoint: < 768px — chat UI collapses Draft Coach panel to a bottom sheet.

### 2.4 Elevation
Shadows are subtle. Four levels:
- `shadow-0` — flat, borders only
- `shadow-1` — `0 1px 2px rgba(0,0,0,0.04)` — cards at rest
- `shadow-2` — `0 4px 12px rgba(0,0,0,0.06)` — popovers, dropdowns
- `shadow-3` — `0 12px 32px rgba(0,0,0,0.10)` — modals, Draft Coach panel

### 2.5 Iconography
Lucide icons, 1.5px stroke. Key icons:
- Lock (private content) — on every private-scoped panel
- Users (case with both parties)
- MessageCircle (chat)
- Sparkles (Draft Coach, synthesis)
- ShieldCheck (privacy reminders)
- Pause (case paused / awaiting other party)

### 2.6 Motion
- Transitions are short (150–200ms) and always `ease-out`.
- AI streaming: a subtle blinking cursor at the end of streaming text. No "typing" dots that bounce playfully — too chipper for the context.
- Route transitions: crossfade (100ms). No slide animations.
- New message arrival: fade-in + 8px upward translate (150ms).
- No celebration animation on case closure. The moment is quiet on purpose.

---

## 3. Navigation Architecture

### 3.1 Site Map

```
Logged out
├── /                         Landing (hero, how it works, CTA)
├── /login                    Magic link + Google OAuth
├── /invite/:token            Invite acceptance (auth if needed)
└── /about                    (v1.1)

Logged in
├── /dashboard                Cases list
├── /cases/new                Case creation form
├── /cases/:caseId            Redirects by status
│   ├── /private              Private coaching chat
│   ├── /ready                Synthesis + "Enter joint chat" CTA
│   ├── /joint                Joint chat (with Draft Coach)
│   └── /closed               Read-only archive
├── /profile                  Display name, email, sign-out
└── /admin/* (role=ADMIN)
    ├── /templates            List
    ├── /templates/:id        Edit + version history
    └── /audit                Audit log
```

### 3.2 Top Navigation

**Logged in (case-less pages — Dashboard, Profile):**
```
┌───────────────────────────────────────────────────────┐
│ Conflict Coach                     [Dashboard] [◉ You]│
└───────────────────────────────────────────────────────┘
```

**Inside a case:**
```
┌────────────────────────────────────────────────────────────┐
│ ← Back to Dashboard │ Case with Jordan • Private Coaching │
└────────────────────────────────────────────────────────────┘
```

The case phase is always visible in the header — users should never wonder what phase they're in.

**Solo mode adds a party toggle:**
```
┌─────────────────────────────────────────────────────────────┐
│ ← Dashboard │ Solo Test Case │ Viewing as: [Alex ▾] [Jordan]│
└─────────────────────────────────────────────────────────────┘
```

The toggle is a prominent segmented control, colored `--coach-accent`, making the solo context unmistakable.

---

## 4. Screen-by-Screen Specifications

### 4.1 Landing Page (`/`)

**Purpose:** Convey the product in 15 seconds; convert to login.

**Layout:**
- Hero: single-sentence tagline ("A calm place to work through a difficult conversation."), short subhead, primary CTA "Start a case."
- Three steps explainer: Private Coaching → Shared Conversation → Resolution. Minimal, iconographic.
- Privacy section: "Your words are yours. Here's how we protect them." Links to privacy policy.
- Footer: terms, privacy, contact.

**Do NOT include:** testimonials (we don't have any in v1), aggressive "Get started free" repeated CTAs, pricing (no pricing in v1).

### 4.2 Login / Register (`/login`)

**Purpose:** Minimal-friction auth.

**Layout:**
- Single centered card, ~400px wide.
- Heading: "Sign in to Conflict Coach"
- Email input + "Send magic link" button (primary)
- Divider: "or"
- "Continue with Google" button (secondary)
- Fine print: "By signing in, you agree to our Terms and Privacy Policy."

**States:**
- Default
- Magic link sent: replace form with a confirmation message ("Check your email…")
- Error: inline below the email input

**No password field.** Intentional — see PRD.

### 4.3 Invite Acceptance (`/invite/:token`)

**Purpose:** Bring the second party in warmly without revealing anything private.

**Layout (logged out):**
- Centered card.
- Heading: "Alex has invited you to work through something together."
- Body (exactly this shape): "Conflict Coach is a private mediation tool. You'll each talk with an AI coach privately before having a facilitated conversation together."
- Button: "Sign in to continue"
- Token persists through auth.

**Layout (logged in, unredeemed):**
- Same framing, but adds:
  - "Alex says the conflict is about:" [initiator's main topic — ONE sentence as they wrote it]
  - "Category: Workplace" (or whichever)
  - [Accept invitation] [Decline]
- Decline → case is marked with `CLOSED_ABANDONED` + short explanation; initiator notified.

**Critical privacy callout:** Invitee sees only what the initiator wrote in the *shared* case form (mainTopic + category) — nothing from private coaching. This is visually labeled: "Alex wrote this in the shared summary. You'll have your own private space to share your perspective."

### 4.4 Dashboard (`/dashboard`)

**Purpose:** See all cases and get into the right one.

**Layout:**
- Top right: `[+ New Case]` primary button
- Section: "Active Cases" (cases not in CLOSED_* states)
- Section: "Closed Cases" (collapsed by default)

**Case row:**
```
┌───────────────────────────────────────────────────────────────┐
│ [icon] Case with Jordan                                      │
│        Workplace · Created Apr 15                             │
│        ● Private coaching — waiting on Jordan                 │
│        Last activity: 2 hours ago                   [Enter →] │
└───────────────────────────────────────────────────────────────┘
```

**Status indicator semantics:**
- `●` (green) — "Your turn" (action required)
- `○` (gray) — "Waiting on the other party"
- `◐` (amber) — "Ready to enter joint chat"
- `◼` (neutral) — Closed

This single-glyph system scales to mobile and avoids verbose status text.

**Empty state:** Friendly, not cutesy. "No cases yet. When you're ready to work through something, start a new case."

### 4.5 Case Creation Form (`/cases/new`)

**Purpose:** Structured intake that doesn't feel like a tax form.

**Layout (single-column, progressive disclosure):**

**Step 1 — Category** (radio cards, not dropdown; tactile choice)
- Workplace
- Family
- Personal relationship
- Contractual / business
- Other

**Step 2 — Main Topic**
- Label: "In one sentence, what's this about?"
- Helper: "This will be visible to the other person when they accept the invitation. Keep it factual, not emotional."
- Character counter (soft limit 140; allows over but discourages)

**Step 3 — Describe the Situation**
- Label: "Tell us more about what's going on."
- Helper: "**Private to you.** This helps the AI coach prepare, and the other person never sees it."
- Textarea, 5 rows, auto-grows.
- Privacy lock icon adjacent to the label, with tooltip: "Only you and the AI coach will see this."

**Step 4 — Desired Outcome**
- Label: "What would a good resolution look like for you?"
- Helper: "**Private to you.** It's okay if you're not sure — just a rough idea helps."
- Textarea, 3 rows.

**Step 5 — Who is this with?**
- Label: "What's their name?"
- Helper: "Just a first name or nickname is fine. You'll send them an invitation link in the next step."

**Solo mode toggle (developer/test):**
- Hidden under an expandable "Advanced" disclosure.
- "Create this as a solo test case (I'll play both parties)" checkbox.

**Submit → Case created, routes to Post-Create screen.**

### 4.6 Post-Create (Invite Sharing) (`/cases/:id/invite`)

**Purpose:** Get the initiator to share the link with the other party.

**Layout:**
- Heading: "Your case is ready. Send this link to Jordan."
- Invite link displayed in a large, copyable field with a "Copy link" primary button.
- Three preset share options:
  - Copy for email (opens mailto: with a pre-written friendly message)
  - Copy for text message (copies a shorter variant)
  - Just copy the link
- Below: "What should I tell them?" — expandable section with suggested language:
  > "Hey Jordan — I found this thing called Conflict Coach. It's a private tool that helps two people work through something difficult together with an AI mediator. I thought it might help us work through the [topic]. Here's a link to join: [link]. No pressure — let me know what you think."
- Secondary: "Or, start your private coaching now →" (they don't have to wait for Jordan to accept before beginning their own private coaching)

### 4.7 Private Coaching (`/cases/:id/private`)

**Purpose:** A confidential conversation with the AI to articulate one's position.

**Layout (full-height, chat-centric):**

```
┌────────────────────────────────────────────────────────────────┐
│ ← Dashboard │ Case with Jordan • Private Coaching              │
├────────────────────────────────────────────────────────────────┤
│  🔒 This conversation is private to you. Jordan will never see │
│     any of it. [Learn more about privacy]                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   Coach:  Hi Alex. I'm here to help you think through what's  │
│           going on. Before we get into anything specific, I'd │
│           like to understand how you're feeling about it right │
│           now. Can you describe that?                          │
│                                                                │
│   You:   Honestly, I'm frustrated. I feel like Jordan doesn't │
│          respect my time.                                      │
│                                                                │
│   Coach:  That's helpful context. Can you tell me about a     │
│           recent moment when you felt that way? [streaming...] │
│                                                                │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ [Textarea: Type your message...]              [Send ↵]        │
├────────────────────────────────────────────────────────────────┤
│ When you've had enough, you can [mark private coaching         │
│ complete] — the joint session starts after you both do.        │
└────────────────────────────────────────────────────────────────┘
```

**Details:**
- Privacy banner is persistent and lockable-looking. The lock icon is not decoration — clicking it opens a modal explaining exactly what's private and why.
- Coach messages rendered in `--accent-subtle` bubbles, left-aligned, with Sparkles icon.
- User messages rendered in `--bg-surface`, right-aligned, no icon.
- The "mark complete" action is a footer CTA, not a big prominent button — we don't want users to rush through private coaching.
- Mark Complete opens a confirmation: "You've had {N} messages with the Coach. Ready to move on to the joint session with Jordan?" with Continue Coaching / Mark Complete buttons.

**Streaming behavior:**
- The AI message appears as a bubble with a blinking cursor.
- Text streams character-by-character.
- Copy button only appears after the message is `COMPLETE`.

**Input states:**
- While AI is responding, input is enabled (user can pre-type the next message) but Send is disabled.
- Shift-enter for newline, enter to send.

### 4.8 Ready for Joint (`/cases/:id/ready`)

**Purpose:** A moment of pause and preparation before the joint session. This screen matters — it's where the product adds unique value.

**Layout:**
```
┌────────────────────────────────────────────────────────────────┐
│ ← Dashboard │ Case with Jordan • Ready for Joint Session       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   You've both completed private coaching. Here's what the      │
│   Coach has prepared for you before the joint session:         │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ 🔒 Private to you — Jordan has their own version       │   │
│  │                                                        │   │
│  │ **Areas of likely agreement**                          │   │
│  │ Both of you value the project's success and both       │   │
│  │ recognize that the current timing tension is solvable. │   │
│  │                                                        │   │
│  │ **Points that will need real discussion**              │   │
│  │ There's a genuine difference in how each of you        │   │
│  │ prioritizes scope vs. deadline…                        │   │
│  │                                                        │   │
│  │ **Suggested approach**                                 │   │
│  │ Start by acknowledging what's working before raising   │   │
│  │ the constraint question…                               │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│   Take your time reading this. When you're ready:              │
│                                                                │
│              [Enter Joint Session →]                           │
│                                                                │
│   (Jordan will see you've entered when they enter too.)        │
└────────────────────────────────────────────────────────────────┘
```

**Details:**
- Synthesis text is formatted with markdown (headings, bold).
- The "Enter" button is large and primary — this IS the main action.
- Once a party enters, the case moves to JOINT_ACTIVE; the other party can enter on their own schedule.
- The synthesis remains accessible from a "View my guidance" link in the joint chat top nav.

### 4.9 Joint Chat (`/cases/:id/joint`)

**Purpose:** The shared conversation, facilitated by the Coach. This is the heart of the product.

**Layout (desktop, 3-column):**
```
┌──────────────────────────────────────────────────────────────────────┐
│ ← Back │ Case with Jordan • Joint Session │ [My guidance] [Close]   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Coach:  Welcome, Alex and Jordan. I'm here to help keep this      │
│           conversation productive. Take it at your own pace.        │
│                                                                      │
│   Jordan: Hey Alex. I want to start by saying I hear you on the     │
│           timing thing…                                              │
│                                                                      │
│   Alex:   Thanks Jordan. I appreciate that. Here's where I'm at... │
│                                                                      │
│   Coach:  ⟡ A point of agreement is starting to emerge: you both   │
│           want the project to succeed and you're both flexible on   │
│           the details. Want to name the specific constraint next?   │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ [Type your message directly, or...] [✨ Draft with Coach]  [Send]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Details:**

**Message authorship visualization:**
- Each participant has a consistent avatar color: Alex = soft blue, Jordan = soft rose, Coach = `--coach-accent` lavender.
- Coach messages have a distinctive left border (`--coach-accent`) and a ⟡ glyph to signal "Coach intervention."
- Timestamps appear on hover.

**Draft Coach entry:**
- Clicking "✨ Draft with Coach" opens the Draft Coach panel (see §4.10).
- Users can also type directly in the input and Send, bypassing Draft Coach entirely. Draft Coach is help, not a gate.

**Real-time indicators:**
- When the other party is typing, a subtle "Jordan is typing..." appears below the input. (Deferred to v1.1 per tech spec, but reserve the visual space in v1.)
- When the Coach is generating, a "Coach is thinking..." inline message.

**Close Case action:**
- "Close" in the top nav opens a modal (see §4.11).

**Mobile layout:**
- Draft Coach becomes a full-screen bottom sheet, not a side panel.
- Top nav collapses to a hamburger.

### 4.10 Draft Coach Panel (modal/side-panel in joint chat)

**Purpose:** Coach a user toward a good message without writing it for them.

**Trigger:** User clicks "Draft with Coach" in the joint chat input bar.

**Layout (desktop — slides in from right, 420px wide, full height):**
```
┌──────────────────────────────────────┐
│ ✨ Draft Coach           🔒  [✕ close]│
├──────────────────────────────────────┤
│  This is private to you. Jordan      │
│  can't see what you're discussing    │
│  here.                               │
├──────────────────────────────────────┤
│                                      │
│  Coach:  What are you trying to say  │
│          next?                       │
│                                      │
│  You:    I want to push back on the  │
│          deadline thing but without  │
│          sounding like I'm blaming   │
│          them.                       │
│                                      │
│  Coach:  Good instinct. What's the   │
│          actual constraint you need  │
│          them to hear?               │
│                                      │
│  You:    [typing...]                 │
│                                      │
├──────────────────────────────────────┤
│ [Textarea]                    [Send] │
│ When you're ready: [Draft it for me]│
└──────────────────────────────────────┘
```

**When the draft is ready:**
```
┌──────────────────────────────────────┐
│ ✨ Draft Coach           🔒  [✕]     │
├──────────────────────────────────────┤
│  Here's a draft based on what we     │
│  talked about:                       │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ "Hey Jordan — I want to be      │  │
│  │ straight with you about the     │  │
│  │ deadline. The constraint isn't  │  │
│  │ ambition, it's that I have a    │  │
│  │ hard commitment on April 30     │  │
│  │ that I can't move. Can we work │  │
│  │ backwards from there together?" │  │
│  └────────────────────────────────┘  │
│                                      │
│  [Send this message] ←  PRIMARY     │
│  [Edit before sending]               │
│  [Keep refining with Coach]          │
│  [Discard]                           │
└──────────────────────────────────────┘
```

**Critical interaction details:**
- The "Send this message" button is the ONLY way the draft reaches the joint chat.
- Clicking Edit drops the draft into the normal joint-chat input, closes the Draft Coach panel, and the user can tweak and send from there.
- Clicking "Keep refining" returns to the coaching conversation; the AI can produce a new draft later.
- Discard closes the panel and marks the `draftSession` as DISCARDED. No message is sent.

**The privacy panel visually:**
- The small lock icon in the header is persistent.
- Hovering it: "Jordan can't see any of this. Only the final message you send goes to the joint chat."

### 4.11 Closure Flow

**Propose closure modal:**
- Triggered by "Close" in joint chat nav.
- Options: "Resolved" / "Not resolved" / "Take a break"
- If "Resolved":
  - Textarea: "Briefly describe what you agreed to." (required, 5 rows)
  - Message: "Jordan will see this summary and confirm. The case won't close until you both agree."
  - [Propose Resolution] [Cancel]
- If "Not resolved":
  - Warning styling.
  - Textarea: "Anything you want Jordan to know? (optional)"
  - Message: "This closes the case immediately for both of you. You can reopen by starting a new case."
  - [Close without resolution] [Cancel]
- If "Take a break":
  - Closes the tab, case stays JOINT_ACTIVE.

**Confirm closure banner (shown to the other party when a closure has been proposed):**
```
┌──────────────────────────────────────────────────────┐
│ 📬 Jordan has proposed resolving this case.         │
│    Their summary: "We agreed to..."                  │
│    [Confirm] [Reject and keep talking]              │
└──────────────────────────────────────────────────────┘
```
- Banner sits above the chat input, below the last message.
- Confirming transitions to CLOSED_RESOLVED and opens the closed-case view.
- Rejecting clears the proposal, optionally with a message to the other party.

### 4.12 Closed Case View (`/cases/:id/closed`)

**Purpose:** Read-only archive.

**Layout:**
- Header with case name, category, closure date, and outcome (Resolved / Not Resolved / Abandoned).
- If Resolved: closure summary prominently displayed.
- Full joint chat transcript (read-only).
- Nav tabs: Joint Chat | My Private Coaching (only accessible to you) | My Guidance
- Banner: "This case is closed. No new messages can be added."

The closed case view never shows the other party's private coaching or their synthesis, ever — even after closure.

### 4.13 Admin Views (P1)

**Admin Templates List (`/admin/templates`):**
- Table: Category | Name | Current Version | Status (Active / Archived) | Pinned Cases Count
- [+ New Template] button
- Click row → edit view

**Template Edit (`/admin/templates/:id`):**
- Two-pane layout:
  - Left: current draft form
    - Category (select)
    - Name (text)
    - Global Guidance (large textarea, markdown)
    - Coach Instructions (textarea, markdown)
    - Draft Coach Instructions (textarea, markdown)
    - Notes (textarea — admin-only changelog)
  - Right: version history timeline
    - Each published version shown with date + admin + notes + "View" button (read-only diff)
- [Publish New Version] button (primary) — creates immutable version
- [Archive Template] button (danger) — confirmation modal

**Audit Log (`/admin/audit`):**
- Filterable table: Actor | Action | Target | Timestamp
- Click row → JSON payload in a drawer
- Not editable.

---

## 5. Component Inventory

### 5.1 Core Components
- `ChatWindow` — base component used by Private Coaching, Joint Chat, Draft Coach
- `MessageBubble` — handles user/coach/system variants
- `StreamingIndicator` — blinking cursor for in-progress AI messages
- `MessageInput` — textarea + send button, with Shift-Enter newline
- `PrivacyBanner` — consistent "this is private" callout
- `PartyAvatar` — colored circle with initial, consistent per party
- `CoachIntervention` — styled coach message with ⟡ glyph
- `PhaseHeader` — top nav showing current case phase
- `StatusPill` — small status indicator for dashboard rows
- `PartyToggle` — solo mode's segmented control

### 5.2 Primitives (shadcn/ui)
- Button (default, primary, secondary, danger, ghost)
- Input, Textarea
- Dialog (modal)
- Sheet (side panel / bottom sheet)
- Tooltip
- Select, RadioGroup
- Card
- Toast (for ephemeral notifications)

---

## 6. Interaction Patterns

### 6.1 Streaming Text
- Character-by-character rendering (not word-by-word — reads less jittery)
- Cursor at the end of streaming text (thin vertical bar, blinks at 500ms)
- Auto-scroll follows streaming unless user has scrolled up (sticky scroll)

### 6.2 Error & Retry
- AI errors render inline as a message bubble with a warning tint and a [Retry] button
- Network errors use a toast, not inline (they're transient)
- Form errors render inline below the input

### 6.3 Loading States
- Use skeleton screens, not spinners, for anything > 300ms
- Dashboard load: skeleton of 3 case rows
- Case detail load: skeleton of the phase-appropriate layout

### 6.4 Empty States
- Friendly copy, never cutesy
- Dashboard empty: "No cases yet. When you're ready to work through something, start a new case."
- Joint chat empty (shouldn't happen — Coach always opens): "Coach is preparing…"
- Admin templates empty: "No templates yet. The app will use a built-in default baseline. Create a template when you want to tune the Coach's behavior per category."

### 6.5 Confirmations
- Destructive or state-changing actions require confirmation modals
- Confirmations describe what will happen: "This will close the case for both of you. Jordan will be notified."
- Never use browser `confirm()` — always a styled modal

### 6.6 Keyboard Shortcuts
- Enter to send (any message input)
- Shift-Enter for newline
- Esc to close any modal or side panel
- Cmd/Ctrl-K to open case search (v1.1)

---

## 7. Accessibility Details

### 7.1 Structural
- Single `<main>` landmark per page
- Chat regions use `role="log"` + `aria-live="polite"`
- New messages are appended; screen readers announce them without disrupting current reading

### 7.2 Focus
- On route change, focus moves to the page's `<h1>`
- On modal open, focus moves to the first focusable element; trapped until close; restored on close
- On Draft Coach panel open, focus moves to the textarea

### 7.3 Visual
- Focus rings use `--accent` with 2px outline + 2px offset
- Never remove focus rings
- Text contrast meets WCAG AA everywhere; verified via Playwright accessibility snapshot

### 7.4 Motion
- Respect `prefers-reduced-motion`: disable streaming cursor animation, route crossfades, and message fade-ins

### 7.5 Screen Reader Copy
- Streaming messages announce "Coach is replying" once, not on every character update
- Privacy banner reads: "Private conversation. Only you and the AI coach see this."
- The "mark complete" CTA reads: "Mark private coaching complete. This moves the case to the joint session with [other party]."

---

## 8. Content & Tone Guidelines

Copy is as much of the design as visuals. A few rules:

- **Never use "arbiter," "judgment," or "verdict."** Use: coach, guidance, synthesis, resolution.
- **Never sound legal.** "What a good outcome would look like" > "desired resolution terms."
- **Use second-person for the user, third-person for the other party.** "You and Jordan" > "the parties."
- **The AI never claims authority.** It "offers," "suggests," "wonders." It doesn't "conclude" or "rule."
- **Privacy copy is plain, not corporate.** "Jordan can't see this" > "This content is restricted from the other party."
- **No exclamation marks from the AI.** The tone is steady, not peppy.
- **Closure copy is understated.** "Case closed." not "🎉 Congratulations on resolving your conflict!"

---

## 9. Edge Cases & Their UI

| Case | UI |
|------|-----|
| Invited party never joins (>7 days) | Initiator sees a "Nudge Jordan" button that re-opens the share screen. After 30 days, case auto-closes as ABANDONED. |
| Other party enters joint chat but goes silent | No special UI in v1. The waiting party sees the chat as-is. |
| AI generates a response rejected by privacy filter twice | Coach posts: "I'm having trouble responding to that right now. Could either of you rephrase?" |
| Cost cap hit mid-conversation | Coach posts a final message explaining; input stays open for direct human exchange without AI |
| User closes tab mid-stream | On reload, the message row reflects final state (complete or error). No weird partial UI. |
| Admin archives a template currently in use | Existing cases continue with their pinned version. Admin sees a warning with a count of pinned cases. |
| Magic link email delayed | Login screen offers "Didn't get it? Try Google instead." |
| Invited party tries to join from a different email than initiator invited | Not checked in v1 (invite is open to whoever has the link; consistent with how most share-link tools work). v1.1 adds optional email-binding. |
| Browser back button in mid-flow | Normal routing; phase is determined by case status, so user can never end up on a phase screen that doesn't match the case state |

---

## 10. Design Artifacts Required Before Build

- [ ] Figma file with all screens in light mode (desktop + mobile breakpoints)
- [ ] Color tokens exported to Tailwind config
- [ ] Icon set selection locked (Lucide subset)
- [ ] Empty-state illustrations — v1 uses no illustrations (text-only empty states); defer illustration pass to post-beta
- [ ] Logo / wordmark for Conflict Coach — simple wordmark in Inter 600, no logomark in v1
- [ ] Favicon + app icons

---

## 11. Open Design Questions

| # | Question | Proposed Default |
|---|----------|------------------|
| D1 | Should the Coach AI have a name or stay "Coach"? | Stay "Coach". A named persona feels like a companion app and overclaims intimacy. |
| D2 | Party color assignment: fixed (initiator = blue) or randomized? | Fixed by role: initiator = blue, invitee = rose, coach = lavender. Consistency over variety. |
| D3 | Should closure have a satisfying visual moment? | No. The design principle is "quiet." A calm confirmation screen, not a celebration. |
| D4 | Dark mode for v1? | Yes — minimal additional effort when tokens are properly used. Ship it. |
| D5 | Should private coaching show message count or time-spent progress? | No. We don't want users to optimize for a metric. Just let them talk until they feel ready. |
| D6 | Visual treatment of the "solo mode" flag — how strong? | Strong. Coach-accent banner, party toggle prominent. Never let a tester confuse their solo case with a real one. |

---

*Conflict Coach · Design Doc v1.0 · Applied Labs · April 2026*
