# Epic Decomposition Plan: WOR-5 — Conflict Coach - v1

## Planning Assumptions

- Greenfield repo — no existing code, framework setup, or dependencies. T1 bootstraps everything.
- Convex Auth (beta) is the auth provider for v1; Clerk swap-out is a contingency not planned as a task.
- Claude Sonnet 4.5 for user-facing AI generation, Haiku 4.5 for classification — API key provisioned as env var.
- All P0 user stories (US-01 through US-15) are in scope; P1 (US-14 admin templates) is included; P2 stories are excluded.
- Solo mode is a view-layer feature per TechSpec §14.7 — built after the core two-party flow works end-to-end.
- Dark mode is included per DesignDoc §11 D4 ('minimal additional effort when tokens are properly used').
- No Figma artifacts exist — the agent implements directly from the DesignDoc screen specs and StyleGuide tokens.
- E2E tests use CLAUDE_MOCK=true with deterministic stub responses per TechSpec §10.4.
- Transcript compression and cost budget tracking are included as they are specified in TechSpec §6.4 and §6.6.
- The 24h cooling-off for unilateral close is deferred to v1.1 per TechSpec §5.2 — v1 unilateral close is immediate.

## Dependency Graph Notes

The graph has a wide fan-out from T1 (scaffolding) and T3 (schema). Auth (T4-T6) gates all authenticated UI. The AI stack is a linear chain: prompt assembly (T16) → streaming infra (T17) → privacy filter (T18) → individual AI roles. Private coaching (T19-T21) must work before synthesis (T22-T23), which gates joint chat (T24-T27), which gates draft coach (T28-T29) and closure (T30-T32). Solo mode (T33) depends on the full core flow. Admin (T34-T36) and testing (T39-T47) are largely parallelizable with each other and with later core tasks. The cron job (T37) and seed data (T38) are independent utilities.

## Proposed Task Graph

Root tasks (no blockers): T1.

Dependencies:
- T2 blocked by T1
- T3 blocked by T1
- T4 blocked by T1, T3
- T5 blocked by T3, T4
- T6 blocked by T1
- T7 blocked by T3, T6
- T8 blocked by T2, T4, T5
- T9 blocked by T8
- T10 blocked by T4, T8
- T11 blocked by T3, T5
- T12 blocked by T8, T11
- T13 blocked by T5, T7
- T14 blocked by T8, T13
- T15 blocked by T14
- T16 blocked by T3, T6
- T17 blocked by T3, T6
- T18 blocked by T6
- T19 blocked by T2
- T20 blocked by T2
- T21 blocked by T7, T16, T17
- T22 blocked by T19, T20, T21
- T23 blocked by T16, T18, T21
- T24 blocked by T8, T20, T23
- T25 blocked by T7, T5
- T26 blocked by T16, T17, T18, T25
- T27 blocked by T19, T25, T26
- T28 blocked by T16, T17, T25
- T29 blocked by T19, T20, T27, T28
- T30 blocked by T7, T25
- T31 blocked by T27, T30
- T32 blocked by T22, T27, T30
- T33 blocked by T8, T22, T27
- T34 blocked by T5, T7, T13
- T35 blocked by T8, T10, T34
- T36 blocked by T14, T35
- T37 blocked by T5, T7
- T38 blocked by T8, T37
- T39 blocked by T3, T5
- T40 blocked by T8, T39
- T41 blocked by T7
- T42 blocked by T3, T37
- T43 blocked by T16, T17
- T44 blocked by T17, T39
- T45 blocked by T8, T11
- T46 blocked by T22, T27, T29, T31
- T47 blocked by T2, T12, T22, T27
- T48 blocked by T7, T16, T18, T43
- T49 blocked by T1, T4
- T50 blocked by T33, T49
- T51 blocked by T35, T49
- T52 blocked by T29, T49
- T53 blocked by T26, T49
- T54 blocked by T38, T49
- T55 blocked by T34, T49
- T56 blocked by T10, T49
- T57 blocked by T48, T49

## Task Breakdown

### T1: Project scaffolding: Vite + React + TS + Convex + Tailwind + shadcn/ui

**Type:** Task

**Summary:** Initialize the repo with Vite React-TS template, install Convex, Tailwind CSS, shadcn/ui, React Router v6, ESLint, Prettier. Configure tsconfig, vite.config, tailwind.config, convex/ directory. Create .env.example with all required env vars. Verify `npm run dev` and `npx convex dev` both start cleanly.

**Acceptance Criteria:**

- Running `npm install && npm run dev` starts the Vite dev server without errors
- Running `npx convex dev` initializes the Convex backend without errors
- TypeScript strict mode is enabled and `tsc --noEmit` passes
- Tailwind utility classes render correctly in a test component
- At least one shadcn/ui primitive (Button) is installed and importable
- React Router v6 is configured with a placeholder route at /
- ESLint and Prettier configs are present and `npm run lint` passes
- .env.example documents all required env vars (VITE_CONVEX_URL, ANTHROPIC_API_KEY, etc.)

### T2: Design tokens and global styles (globals.css, theme.ts, tailwind config)

**Type:** Task

**Summary:** Implement the full color palette, typography scale, spacing, radius, and shadow tokens from the StyleGuide as CSS custom properties in globals.css. Extend tailwind.config to map tokens to utility classes. Create theme.ts for programmatic access. Set up Inter and JetBrains Mono font loading. Implement light and dark mode token values using prefers-color-scheme.

**Depends on:** T1

**Acceptance Criteria:**

- All color tokens from StyleGuide §2.2 are defined as CSS custom properties in globals.css
- Dark mode token variants are defined and toggle via prefers-color-scheme or a data attribute
- Tailwind config extends theme with custom colors mapped to CSS vars (e.g., bg-canvas, text-primary, accent)
- Typography scale matches StyleGuide §3.3 (display through timestamp sizes)
- Inter (400/500/600) and JetBrains Mono (400/500) are loaded
- Radius tokens (sm/md/lg/xl/full) and shadow tokens (0-3) are available as Tailwind utilities
- Font smoothing is set globally per StyleGuide §3.4

### T3: Convex schema definition (all tables)

**Type:** Task

**Summary:** Create convex/schema.ts with all tables exactly as specified in TechSpec §3.1: users, cases, partyStates, privateMessages, jointMessages, draftSessions, draftMessages, inviteTokens, templates, templateVersions, auditLog. Include all indexes. This is the source of truth for the entire data model.

**Depends on:** T1

**Acceptance Criteria:**

- convex/schema.ts compiles without errors and matches TechSpec §3.1 exactly
- All tables have correct field types and validators
- All indexes are defined (by_email, by_initiator, by_invitee, by_case, by_case_and_user, by_token, by_category, by_template, by_actor, by_draft_session)
- `npx convex dev` deploys the schema successfully
- Key invariants are documented as comments: templateVersionId immutability, privateMessages isolation, schemaVersion presence

### T4: Convex Auth setup (magic link + Google OAuth)

**Type:** Task

**Summary:** Configure Convex Auth with magic link and Google OAuth providers. Set up auth config in convex/auth.config.ts. Create the ConvexProviderWithAuth wrapper in the client. Wire environment variables for Google OAuth client ID/secret and magic link email sender.

**Depends on:** T1, T3

**Acceptance Criteria:**

- Convex Auth is initialized with magic-link and Google OAuth providers
- Auth config references correct env vars (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, MAGIC_LINK_EMAIL_FROM)
- ConvexProviderWithAuth wraps the React app in main.tsx
- ctx.auth.getUserIdentity() returns identity for authenticated users in Convex functions
- Session persists across browser reloads (30-day expiry)

### T5: User upsert on login and role management

**Type:** Task

**Summary:** Create the user upsert logic that runs on first login: look up user by email in the users table, create if not found with role=USER. Create a getUserByEmail helper. Admin promotion is manual DB action only (no self-serve). Export a requireAuth helper that validates identity and returns the user record.

**Depends on:** T3, T4

**Acceptance Criteria:**

- On first login, a users row is created with email, role=USER, and createdAt
- On subsequent logins, the existing user record is returned without duplication
- getUserByEmail helper is exported and reusable across all Convex functions
- requireAuth helper throws UNAUTHENTICATED if no identity and USER_NOT_FOUND if no user record
- Admin role check (user.role === 'ADMIN') is available as a helper

### T6: Error code normalization (ConvexError wrapper)

**Type:** Task

**Summary:** Create a shared error utility that wraps all thrown errors in a ConvexError with shape { code, message, httpStatus } per TechSpec §7.4. Define all error codes: UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, INVALID_INPUT, TOKEN_INVALID, RATE_LIMITED, AI_ERROR, INTERNAL.

**Depends on:** T1

**Acceptance Criteria:**

- A throwAppError(code, message) utility is exported from convex/lib/errors.ts
- All 9 error codes from TechSpec §7.4 are defined as constants
- Each error code maps to an appropriate HTTP status (401, 403, 404, 409, 400, 400, 429, 502, 500)
- ConvexError instances include code, message, and httpStatus fields
- Client-side error parsing utility extracts code and message from ConvexError responses

### T7: Case lifecycle state machine helper

**Type:** Task

**Summary:** Create convex/lib/stateMachine.ts that encodes the case lifecycle from TechSpec §5. Define all valid states, all valid transitions, and a validateTransition(currentStatus, targetStatus) function. Every mutation that changes case status must call through this module. Include the per-party state tracking (both must complete PC before READY_FOR_JOINT, etc.).

**Depends on:** T3, T6

**Acceptance Criteria:**

- All 7 case statuses are defined as a union type
- All valid transitions are enumerated (DRAFT_PRIVATE_COACHING → BOTH_PRIVATE_COACHING, etc.)
- validateTransition throws CONFLICT error for illegal transitions
- Helper functions: canEnterJointChat(case), canProposeClosure(case, userId), canConfirmClosure(case, userId)
- Transition from BOTH_PRIVATE_COACHING → READY_FOR_JOINT requires both parties' privateCoachingCompletedAt to be set
- Closure requires proposer + confirmer to be different parties (or same user in solo mode)

### T8: Layout shell, routing, and top navigation

**Type:** Task

**Summary:** Create App.tsx with React Router v6 routes matching TechSpec §9.2. Build TopNav component with case-context header, back-to-dashboard link, and user menu. Set up authenticated route guards. Create placeholder pages for all routes.

**Depends on:** T2, T4, T5

**Acceptance Criteria:**

- All routes from TechSpec §9.2 are defined (/, /login, /invite/:token, /dashboard, /cases/new, /cases/:caseId, /cases/:caseId/private, /cases/:caseId/joint, /cases/:caseId/closed, /admin/templates, /admin/templates/:id, /admin/audit)
- Authenticated routes redirect to /login when not logged in
- Admin routes check for ADMIN role and show 403 for non-admins
- TopNav renders context-appropriate header (dashboard vs. inside-case views per DesignDoc §3.2)
- Semantic HTML landmarks: <main>, <nav> per DesignDoc §7.1
- Max-width constraints applied: 720px for reading, 1080px for chat per DesignDoc §2.3

### T9: Landing page

**Type:** Story

**Summary:** Build the logged-out landing page at / per DesignDoc §4.1. Hero section with tagline, three-step explainer (Private Coaching → Shared Conversation → Resolution), privacy section, footer with terms/privacy links. Primary CTA routes to /login.

**Depends on:** T8

**Acceptance Criteria:**

- Landing page renders at / for logged-out users
- Hero displays tagline: 'A calm place to work through a difficult conversation.'
- Three-step explainer section is present with iconographic layout
- Privacy section with 'Your words are yours' messaging is present
- Footer includes terms and privacy policy links
- Primary CTA 'Start a case' routes to /login
- Logged-in users are redirected to /dashboard
- No testimonials, no pricing, no repeated CTAs per DesignDoc §4.1

### T10: Login / Register page

**Type:** Story

**Summary:** Build the login page at /login per DesignDoc §4.2. Centered card with email input + 'Send magic link' button, divider, 'Continue with Google' button. Handle magic-link-sent confirmation state and error states. Include ToS/privacy fine print.

**Depends on:** T4, T8

**Acceptance Criteria:**

- Login page renders a centered 400px card
- Email input + 'Send magic link' primary button triggers Convex Auth magic link flow
- 'Continue with Google' secondary button triggers Google OAuth flow
- After magic link sent, form replaced with 'Check your email' confirmation message
- Error states render inline below the email input
- Fine print 'By signing in, you agree to our Terms and Privacy Policy' is present with links
- No password field per PRD US-01
- Successful auth redirects to /dashboard (or invite URL if token was stashed)

### T11: Dashboard backend (cases/list query)

**Type:** Task

**Summary:** Implement the cases/list Convex query that returns all cases for the current user (as initiator or invitee). Include case status, other party display name (phase-level only), category, created date, and last activity time. Enforce auth.

**Depends on:** T3, T5

**Acceptance Criteria:**

- cases/list query returns cases where user is initiatorUserId OR inviteeUserId
- Each case includes: id, status, category, createdAt, updatedAt, other party's displayName, isSolo flag
- Other party's private content is never included — only phase-level status (hasCompletedPC boolean)
- Results are sorted by updatedAt descending
- Query requires authentication; unauthenticated calls throw UNAUTHENTICATED
- Query is reactive (clients auto-update when case data changes)

### T12: Dashboard frontend

**Type:** Story

**Summary:** Build the Dashboard page at /dashboard per DesignDoc §4.4. Active Cases and Closed Cases sections, case rows with status indicators (green/gray/amber/neutral dots), 'New Case' button. Empty state. Click routes to case detail.

**Depends on:** T8, T11

**Acceptance Criteria:**

- Dashboard lists cases grouped by Active (non-CLOSED_*) and Closed sections
- Closed section is collapsed by default
- Each case row shows: other party name, category, created date, current status text, last activity time, Enter button
- Status indicators use correct glyphs: ● green (your turn), ○ gray (waiting), ◐ amber (ready for joint), ◼ neutral (closed)
- '+New Case' primary button routes to /cases/new
- Empty state: 'No cases yet. When you're ready to work through something, start a new case.'
- Click on case row routes to /cases/:caseId

### T13: Case creation backend (cases/create mutation + invite token)

**Type:** Task

**Summary:** Implement the cases/create mutation per TechSpec §7.2. Creates a case with status DRAFT_PRIVATE_COACHING, the initiator's partyStates row, and a crypto-random invite token (32 url-safe chars). For solo mode (isSolo=true), bind both roles to the same user and skip invite generation. Return caseId + invite URL.

**Depends on:** T5, T7

**Acceptance Criteria:**

- Mutation accepts { category, mainTopic, description, desiredOutcome, isSolo? }
- Creates case with status=DRAFT_PRIVATE_COACHING, schemaVersion=1, templateVersionId from current active template for category
- Creates partyStates row for initiator with role=INITIATOR and form fields populated
- Generates a 32-char crypto-random url-safe invite token and stores it with status=ACTIVE
- Returns { caseId, inviteUrl } where inviteUrl uses SITE_URL env var
- For isSolo=true: sets inviteeUserId to same user, creates both partyStates rows, sets status to BOTH_PRIVATE_COACHING, no invite token generated
- Input validation: category must be one of workplace/family/personal/contractual/other; mainTopic required

### T14: Case creation frontend (multi-step form)

**Type:** Story

**Summary:** Build the case creation form at /cases/new per DesignDoc §4.5. Progressive disclosure with 5 steps: Category (radio cards), Main Topic (with character counter), Description (private, with lock icon), Desired Outcome (private), Other Party Name. Solo mode toggle under Advanced disclosure. Submit creates case and routes to invite sharing screen.

**Depends on:** T8, T13

**Acceptance Criteria:**

- Form uses radio card selection for category (Workplace, Family, Personal relationship, Contractual/business, Other)
- Main Topic step has a soft 140-char counter and helper text about visibility
- Description step shows lock icon + 'Private to you' helper text, auto-growing textarea
- Desired Outcome step shows lock icon + 'Private to you' helper text
- Solo mode checkbox is hidden under an 'Advanced' expandable section
- Submit calls cases/create mutation and routes to post-create invite screen on success
- Form validation: category and mainTopic are required; inline error messages

### T15: Post-create invite sharing screen

**Type:** Story

**Summary:** Build the invite sharing screen shown after case creation per DesignDoc §4.6. Large copyable invite link field, share option buttons (email, text, copy), suggested messaging for the other party, and a secondary CTA to start private coaching immediately.

**Depends on:** T14

**Acceptance Criteria:**

- Screen shows 'Your case is ready. Send this link to [name].' heading
- Invite link is displayed in a large, monospace copyable field with a 'Copy link' button
- Three share options: Copy for email (mailto:), Copy for text message (shorter), Just copy link
- Expandable 'What should I tell them?' section with suggested sharing language per DesignDoc §4.6
- Secondary CTA: 'Or, start your private coaching now →' links to /cases/:id/private
- Copy button shows success feedback (toast or button state change)

### T16: AI prompt assembly module

**Type:** Task

**Summary:** Create convex/lib/prompts.ts with the assemblePrompt function per TechSpec §6.3. Handles all four AI roles: PRIVATE_COACH, COACH, DRAFT_COACH, SYNTHESIS. Each role has specific context injection rules, system prompt content, and privacy boundaries. Template version instructions are merged when available.

**Depends on:** T3, T6

**Acceptance Criteria:**

- assemblePrompt function accepts { role, caseId, actingUserId, recentHistory, templateVersion? } and returns { system, messages }
- PRIVATE_COACH: uses hardcoded system prompt from TechSpec §6.3.1; context includes only acting user's form fields + their private message history; NO other party data
- SYNTHESIS: system prompt includes anti-quotation rules verbatim from TechSpec §6.3.2; includes both parties' private content; outputs JSON format
- COACH: merges template instructions if available; context includes joint chat history + both synthesis texts; NO raw private messages
- DRAFT_COACH: context includes drafting user's joint-chat history + their own synthesis only; NO other party's synthesis or private content
- Template version instructions (globalGuidance, coachInstructions, draftCoachInstructions) are prepended to system prompt when present

### T17: AI streaming infrastructure

**Type:** Task

**Summary:** Build the reusable streaming pattern for AI responses per TechSpec §6.2. An action inserts a message row with status=STREAMING, calls Claude with stream=true, batches token updates via mutations (~50ms intervals), and sets status=COMPLETE on finish. Handle ERROR status on failure with retry support.

**Depends on:** T3, T6

**Acceptance Criteria:**

- Reusable streamAIResponse helper handles the insert→stream→update→complete lifecycle
- Message row is inserted with status=STREAMING and empty content before Claude is called
- Streaming tokens are batched and flushed via mutation calls at ~50ms intervals
- On completion, final mutation sets status=COMPLETE and records total token count
- On error, status is set to ERROR with error details in content
- AI error handling matches TechSpec §6.5: retry once on 429, mark ERROR on timeout >30s, handle content filter
- Anthropic SDK is initialized with ANTHROPIC_API_KEY env var, never exposed to client

### T18: Privacy response filter (token-substring checker)

**Type:** Task

**Summary:** Build the server-side privacy response filter per TechSpec §6.3.2. Tokenizes the other party's private messages, checks AI output for any substring ≥8 consecutive tokens matching private content. If match found, triggers regeneration (up to 2 retries), then falls back to generic synthesis + admin flag.

**Depends on:** T6

**Acceptance Criteria:**

- checkPrivacyViolation(aiOutput, otherPartyMessages) returns { isViolation, matchDetails }
- Tokenization splits messages into words/tokens for substring matching
- Match threshold: ≥8 consecutive tokens from any private message found in AI output
- Function is reusable by both Synthesis and Coach actions
- Retry logic: up to 2 regeneration attempts if violation detected
- On final failure: returns generic fallback text + flags for admin review via audit log
- Edge cases handled: empty messages, very short messages (< 8 tokens skipped), punctuation normalization

### T19: Shared chat UI components (ChatWindow, MessageBubble, MessageInput, StreamingIndicator)

**Type:** Task

**Summary:** Build the shared chat component library per TechSpec §9.4 and DesignDoc §5.1. ChatWindow is the base used by Private Coaching, Joint Chat, and Draft Coach. MessageBubble handles user/coach/system variants with streaming state. MessageInput with Enter-to-send and Shift-Enter-for-newline. StreamingIndicator with blinking cursor.

**Depends on:** T2

**Acceptance Criteria:**

- ChatWindow renders a scrollable message list with auto-scroll (disabled when user scrolls up)
- MessageBubble renders differently by author type: user (right-aligned, --bg-surface), coach (left-aligned, --accent-subtle with Sparkles icon), system
- MessageBubble handles status states: STREAMING (blinking cursor, no copy), COMPLETE (copy + timestamp), ERROR (warning tint + Retry button)
- MessageInput: Enter sends, Shift-Enter newline, disabled Send while AI is streaming
- StreamingIndicator: thin vertical bar cursor blinking at 500ms per DesignDoc §6.1
- Chat messages use role='log' with aria-live='polite' per DesignDoc §7.1
- Copy button appears only on COMPLETE messages
- Components accept configuration props to work in private, joint, and draft contexts

### T20: Privacy banner component

**Type:** Task

**Summary:** Build the reusable PrivacyBanner component per DesignDoc §5.1. Shows lock icon + 'This conversation is private to you' message with --private-tint background. Clickable lock opens a modal explaining what's private and why. Used in private coaching, synthesis view, and draft coach.

**Depends on:** T2

**Acceptance Criteria:**

- PrivacyBanner renders with lock icon, private-tint background, and configurable text
- Lock icon click opens a modal explaining privacy boundaries
- Screen reader text: 'Private conversation. Only you and the AI coach see this.'
- Component accepts otherPartyName prop for personalized copy ('Jordan can't see this')
- Visual style matches DesignDoc §4.7: persistent banner, lock icon is not decorative

### T21: Private coaching backend (queries + mutations + AI action)

**Type:** Task

**Summary:** Implement privateCoaching/myMessages query, privateCoaching/sendUserMessage mutation, privateCoaching/markComplete mutation, and privateCoaching/generateAIResponse action per TechSpec §7. Enforce that myMessages only returns the caller's own messages. markComplete sets privateCoachingCompletedAt and triggers synthesis if both parties are done.

**Depends on:** T7, T16, T17

**Acceptance Criteria:**

- myMessages query returns only messages where userId matches the authenticated caller — never the other party's messages
- sendUserMessage mutation inserts a privateMessages row with role=USER, status=COMPLETE and schedules generateAIResponse action
- generateAIResponse action calls assemblePrompt with PRIVATE_COACH role and streams response into privateMessages
- markComplete mutation sets privateCoachingCompletedAt; if both parties complete, schedules synthesis/generate action
- markComplete is idempotent (calling twice does not error)
- All functions enforce authentication and party-to-case authorization
- State validation: sendUserMessage rejects if case is not in DRAFT_PRIVATE_COACHING or BOTH_PRIVATE_COACHING

### T22: Private coaching frontend (PrivateCoachingView)

**Type:** Story

**Summary:** Build the private coaching chat view at /cases/:id/private per DesignDoc §4.7. Full-height chat layout with PrivacyBanner, ChatWindow with coach messages (left) and user messages (right), MessageInput, and a 'Mark private coaching complete' footer CTA with confirmation dialog.

**Depends on:** T19, T20, T21

**Acceptance Criteria:**

- Privacy banner is persistent at top: 'This conversation is private to you. Jordan will never see any of it.'
- Coach messages render left-aligned with --accent-subtle background and Sparkles icon
- User messages render right-aligned with --bg-surface background
- Streaming messages show blinking cursor; copy button appears only after COMPLETE
- 'Mark private coaching complete' is a footer CTA (not prominently placed)
- Mark Complete opens confirmation dialog showing message count: 'You've had {N} messages with the Coach. Ready to move on?'
- After marking complete, view becomes read-only with a status message
- Input is enabled while AI is responding (user can pre-type) but Send is disabled during streaming

### T23: AI Synthesis generation (backend action + response filter)

**Type:** Task

**Summary:** Implement the synthesis/generate action per TechSpec §6.3.2. Called when both parties mark PC complete. Reads both parties' private content, calls Claude Sonnet with the synthesis system prompt, validates JSON output, runs the privacy response filter, and writes per-party synthesis to partyStates. Advances case to READY_FOR_JOINT.

**Depends on:** T16, T18, T21

**Acceptance Criteria:**

- Action reads both parties' private messages and form fields as context
- System prompt contains verbatim anti-quotation rules from TechSpec §6.3.2
- Claude response is parsed as JSON with shape { forInitiator: string, forInvitee: string }
- Privacy response filter runs on each synthesis text against the OTHER party's private messages
- On filter violation: regenerate up to 2 times; on final failure, use generic fallback + flag for review
- Synthesis texts are written to partyStates.synthesisText + synthesisGeneratedAt
- Case status advances to READY_FOR_JOINT in the same mutation that writes synthesis
- Synthesis is one-shot, non-streaming per TechSpec TQ3

### T24: Ready for Joint frontend (synthesis display + enter CTA)

**Type:** Story

**Summary:** Build the ReadyForJointView at /cases/:id/ready per DesignDoc §4.8. Shows the user's personalized synthesis in a private-tinted card with lock icon, markdown-formatted sections (areas of agreement, points of contention, suggested approach). Large 'Enter Joint Session' CTA. Entering advances case to JOINT_ACTIVE.

**Depends on:** T8, T20, T23

**Acceptance Criteria:**

- Synthesis card renders with --private-tint background and lock icon
- Label: 'Private to you — Jordan has their own version'
- Synthesis text is rendered with markdown formatting (headings, bold)
- Three sections visible: Areas of likely agreement, Points needing discussion, Suggested approach
- 'Enter Joint Session' is a large primary button — the single primary action on the page
- Clicking Enter advances case status to JOINT_ACTIVE via mutation
- Note below CTA: 'Jordan will see you've entered when they enter too.'
- Synthesis remains accessible via 'View my guidance' link after entering joint chat

### T25: Joint chat backend (queries + mutations)

**Type:** Task

**Summary:** Implement jointChat/messages query, jointChat/sendUserMessage mutation, and jointChat/mySynthesis query per TechSpec §7. Messages are visible to both parties. sendUserMessage inserts a user message and schedules coach evaluation. Enforce case must be in JOINT_ACTIVE status.

**Depends on:** T7, T5

**Acceptance Criteria:**

- jointChat/messages query returns all jointMessages for a case, ordered by createdAt
- Query enforces caller is a party to the case (via partyStates lookup)
- Query rejects if case is not in JOINT_ACTIVE or CLOSED_* status
- sendUserMessage mutation inserts a jointMessage with authorType=USER, schedules generateCoachResponse action
- jointChat/mySynthesis query returns caller's synthesisText from partyStates
- All functions enforce auth + party-to-case authorization
- State validation: sendUserMessage rejects if case is not JOINT_ACTIVE (throws CONFLICT)

### T26: Coach facilitator AI action (Haiku gate + Sonnet generation)

**Type:** Task

**Summary:** Implement jointChat/generateCoachResponse action per TechSpec §6.3.3. First runs Haiku classification gate on the last user message (INFLAMMATORY / PROGRESS / QUESTION_TO_COACH / NORMAL_EXCHANGE). Coach only responds for non-NORMAL_EXCHANGE unless timer fires. Uses Sonnet for response generation. Privacy filter applied to output.

**Depends on:** T16, T17, T18, T25

**Acceptance Criteria:**

- Haiku classification gate categorizes last message as INFLAMMATORY, PROGRESS, QUESTION_TO_COACH, or NORMAL_EXCHANGE
- Coach generates a response for INFLAMMATORY, PROGRESS, and QUESTION_TO_COACH triggers
- Coach stays silent for NORMAL_EXCHANGE (no message inserted)
- Coach context includes joint chat history + both parties' synthesis texts (NOT raw private messages)
- Privacy response filter runs on coach output against both parties' private messages
- Coach opening message is generated when case enters JOINT_ACTIVE (grounded in case's main topic)
- Coach messages have authorType=COACH, isIntervention=true for inflammatory responses
- Streaming response follows the standard streaming infrastructure pattern

### T27: Joint chat frontend (JointChatView)

**Type:** Story

**Summary:** Build the JointChatView at /cases/:id/joint per DesignDoc §4.9. Full chat with both parties' messages + Coach messages in real time. Party-colored avatars (initiator=blue, invitee=rose, coach=lavender). Coach messages have left border + ⟡ glyph. Input area with direct send and 'Draft with Coach' button. 'My guidance' and 'Close' nav actions.

**Depends on:** T19, T25, T26

**Acceptance Criteria:**

- Messages from both parties and Coach render in real time (reactive Convex query)
- Party avatars use correct colors: initiator=--party-initiator, invitee=--party-invitee, coach=--coach-accent
- Coach messages have --coach-subtle background, --coach-accent left border, and ⟡ glyph
- Timestamps appear on hover
- Input area has direct text input + Send button + 'Draft with Coach' button with sparkles icon
- 'My guidance' link in top nav opens synthesis in a side panel or modal
- 'Close' in top nav opens closure modal
- 'Coach is thinking...' indicator shows during coach AI generation
- Mobile: responsive layout per DesignDoc §4.9

### T28: Draft Coach backend (sessions, messages, AI action)

**Type:** Task

**Summary:** Implement draftCoach/startSession, draftCoach/sendMessage, draftCoach/sendFinalDraft, draftCoach/discardSession mutations and draftCoach/generateResponse action per TechSpec §7. Draft Coach has an exploratory conversation, detects readiness signals, produces a structured draft. sendFinalDraft calls jointChat/sendUserMessage internally.

**Depends on:** T16, T17, T25

**Acceptance Criteria:**

- startSession creates a draftSessions row with status=ACTIVE
- sendMessage inserts a draftMessages row and schedules generateResponse action
- generateResponse uses DRAFT_COACH prompt role; context includes drafting user's joint-chat history + their synthesis only
- Readiness detection: action checks user messages for readiness signals ('draft it', 'write the message', etc.) or canonical 'Generate Draft' button message
- On readiness: response contains structured { draft: '...' } and sets draftSession.finalDraft
- sendFinalDraft reads finalDraft, calls jointChat/sendUserMessage, marks session SENT
- discardSession marks session DISCARDED, no message sent
- draftCoach/session query returns current active session + messages for caller

### T29: Draft Coach frontend (DraftCoachPanel + DraftReadyCard)

**Type:** Story

**Summary:** Build the Draft Coach side panel per DesignDoc §4.10. Slides in from right (420px, full height) on desktop, bottom sheet on mobile. Private chat with Draft Coach. When draft is ready, show DraftReadyCard with Send/Edit/Continue/Discard buttons. Only Send posts to joint chat.

**Depends on:** T19, T20, T27, T28

**Acceptance Criteria:**

- Panel opens from 'Draft with Coach' button in joint chat input bar
- Privacy banner in panel header: lock icon + 'This is private to you. Jordan can't see what you're discussing here.'
- Chat interface within panel uses shared ChatWindow components
- 'Draft it for me' button sends canonical readiness message
- When finalDraft is set, DraftReadyCard renders the draft in a highlighted card
- DraftReadyCard has 4 actions: Send this message (primary), Edit before sending, Keep refining with Coach, Discard
- Send calls draftCoach/sendFinalDraft — the ONLY path to posting the draft to joint chat
- Edit drops draft text into joint chat input, closes panel
- Discard calls draftCoach/discardSession, closes panel
- Desktop: side panel (shadow-3); Mobile: full-screen bottom sheet per DesignDoc §4.9

### T30: Case closure backend (propose, confirm, unilateral)

**Type:** Task

**Summary:** Implement jointChat/proposeClosure, jointChat/confirmClosure, and jointChat/unilateralClose mutations per TechSpec §7.2 and §5.2. Propose sets closureProposed + stores summary. Confirm (by other party) transitions to CLOSED_RESOLVED. Unilateral transitions to CLOSED_UNRESOLVED immediately (no 24h cooling-off in v1).

**Depends on:** T7, T25

**Acceptance Criteria:**

- proposeClosure sets caller's partyStates.closureProposed=true and stores closureSummary on case
- confirmClosure validates other party has proposed, sets closureConfirmed=true, transitions case to CLOSED_RESOLVED with closedAt timestamp
- unilateralClose transitions case to CLOSED_UNRESOLVED immediately with closedAt + reason
- Rejection: a mutation to clear the proposer's closureProposed flag exists
- All mutations enforce: caller is party to case, case is JOINT_ACTIVE
- CLOSED_* cases become read-only: sendUserMessage rejects with CONFLICT
- State machine validateTransition is called for all status changes

### T31: Case closure frontend (modal + confirmation banner)

**Type:** Story

**Summary:** Build the closure UI per DesignDoc §4.11. 'Close' button in joint chat nav opens a modal with Resolved/Not resolved/Take a break options. Resolved requires summary textarea + proposes to other party. Confirmation banner shown to the other party with Confirm/Reject buttons.

**Depends on:** T27, T30

**Acceptance Criteria:**

- Close button in joint chat header opens a styled modal (not browser confirm)
- Three options: Resolved (with summary textarea), Not resolved (warning styled, optional note), Take a break (just closes tab)
- 'Propose Resolution' button calls proposeClosure mutation
- Confirmation banner renders above chat input for the other party when closure is proposed
- Banner shows proposer's summary + Confirm and 'Reject and keep talking' buttons
- Confirm calls confirmClosure; case transitions to CLOSED_RESOLVED
- Reject clears proposal; both parties continue chatting
- Confirmation modals describe consequences: 'This closes the case for both of you.'

### T32: Closed case view (read-only archive)

**Type:** Story

**Summary:** Build the ClosedCaseView at /cases/:id/closed per DesignDoc §4.12. Read-only archive showing case metadata, closure outcome, full joint chat transcript, and tabs to view own private coaching and synthesis. Banner states case is closed.

**Depends on:** T22, T27, T30

**Acceptance Criteria:**

- Header shows case name, category, closure date, and outcome (Resolved / Not Resolved / Abandoned)
- If Resolved: closure summary is prominently displayed
- Full joint chat transcript renders read-only (no input)
- Tab navigation: Joint Chat | My Private Coaching | My Guidance
- My Private Coaching tab shows only the viewer's own private coaching messages
- My Guidance tab shows the viewer's own synthesis text
- Banner: 'This case is closed. No new messages can be added.'
- Other party's private coaching and synthesis are NEVER shown

### T33: Solo mode (party toggle + dual-context simulation)

**Type:** Story

**Summary:** Implement solo mode per TechSpec §9.3 and DesignDoc §3.2. PartyToggle segmented control in top nav for solo cases. Toggle state stored in URL query param (?as=initiator|invitee). useActingPartyUserId hook reads the toggle and passes correct userId to all queries. AI treats each party as separate (separate private coaching contexts).

**Depends on:** T8, T22, T27

**Acceptance Criteria:**

- 'New Solo Case' option creates case with isSolo=true via cases/create mutation
- PartyToggle segmented control appears in top nav for solo cases only, colored --coach-accent
- Toggle state persists in URL query param ?as=initiator|invitee (survives refresh)
- useActingPartyUserId hook returns the appropriate userId based on toggle state
- All data queries respect the toggle — private coaching shows different content for each party
- AI generates separate private coaching responses for each party context
- Solo cases are visually distinct: prominent banner + toggle per DesignDoc D6
- Dashboard flags solo cases distinctly from real cases

### T34: Invite redemption backend (invites/redeem mutation)

**Type:** Task

**Summary:** Implement the invites/redeem mutation per TechSpec §4.4 and §7.2. Validates token is ACTIVE, binds authenticated user as invitee on the case, creates their partyStates row with role=INVITEE, marks token CONSUMED. All in one atomic transaction. Reusing a consumed token returns TOKEN_INVALID error.

**Depends on:** T5, T7, T13

**Acceptance Criteria:**

- Mutation looks up token by inviteTokens.by_token index
- Validates token status is ACTIVE; throws TOKEN_INVALID if CONSUMED or REVOKED
- Prevents self-invite: initiator cannot redeem their own case's invite
- Atomically: sets cases.inviteeUserId, creates partyStates row (role=INVITEE), sets token status=CONSUMED + consumedAt + consumedByUserId
- Case status transitions from DRAFT_PRIVATE_COACHING to BOTH_PRIVATE_COACHING
- Returns { caseId } on success
- Re-redemption of consumed token fails with TOKEN_INVALID error and offers login/dashboard options

### T35: Invite acceptance frontend (/invite/:token page)

**Type:** Story

**Summary:** Build the InviteAcceptPage at /invite/:token per DesignDoc §4.3. Logged-out: explains Conflict Coach + 'Sign in to continue' (token persists through auth). Logged-in + unredeemed: shows initiator's main topic + category + Accept/Decline buttons. Privacy callout that only shared summary is shown.

**Depends on:** T8, T10, T34

**Acceptance Criteria:**

- Logged-out view: centered card with 'Alex has invited you to work through something together', product explanation, 'Sign in to continue' button
- Token is stashed in URL/localStorage and survives auth flow
- Logged-in + unredeemed view: shows initiator's mainTopic and category (NOT private coaching content)
- Privacy callout: 'Alex wrote this in the shared summary. You'll have your own private space to share your perspective.'
- Accept button calls invites/redeem mutation; routes to case form to fill invitee's description
- Decline button marks case as CLOSED_ABANDONED with explanation
- Already-consumed token shows error with 'Log in' and 'Go to dashboard' options
- After accepting, invitee fills their own case form (mainTopic, description, desiredOutcome)

### T36: Invitee case form (post-acceptance form submission)

**Type:** Task

**Summary:** After accepting an invite, the invitee fills their own case form (same shape as initiator's: mainTopic, description, desiredOutcome) via the cases/updateMyForm mutation. Their entries are private. On submit, route to private coaching.

**Depends on:** T14, T35

**Acceptance Criteria:**

- cases/updateMyForm mutation updates the invitee's partyStates form fields
- Mutation enforces caller is a party to the case
- Form UI matches case creation form steps 2-4 (mainTopic, description with lock, desiredOutcome with lock)
- Privacy lock icons and helper text are present on private fields
- On submit, route to /cases/:id/private to begin private coaching
- Form validates: mainTopic is required

### T37: Admin template CRUD backend

**Type:** Task

**Summary:** Implement admin/templates/create, admin/templates/publishNewVersion, admin/templates/archive mutations and admin/templates/listAll, admin/templateVersions/list queries per TechSpec §7. All gated by server-side role=ADMIN check. Publishing creates an immutable templateVersion row. Archiving sets archivedAt but doesn't affect pinned cases.

**Depends on:** T5, T7

**Acceptance Criteria:**

- All admin mutations verify user.role === 'ADMIN'; throw FORBIDDEN otherwise
- admin/templates/create creates template + initial templateVersion, returns templateId
- admin/templates/publishNewVersion creates new immutable templateVersion row, updates template.currentVersionId
- Version numbers are monotonically increasing within a template
- admin/templates/archive sets archivedAt; archived templates hidden from category picker but pinned cases unaffected
- admin/templates/listAll returns all templates including archived (admin view)
- admin/templateVersions/list returns all versions for a template, ordered by version desc
- Audit log entry written for each create/publish/archive action

### T38: Admin template UI (list + edit + version history)

**Type:** Story

**Summary:** Build admin template management pages per DesignDoc §4.13. List page at /admin/templates with table view. Edit page at /admin/templates/:id with two-pane layout: left is the edit form (category, name, globalGuidance, coachInstructions, draftCoachInstructions, notes), right is version history timeline. Archive with confirmation.

**Depends on:** T8, T37

**Acceptance Criteria:**

- Template list page shows table: Category, Name, Current Version, Status (Active/Archived), Pinned Cases Count
- '+ New Template' button opens create form
- Edit page has two-pane layout: left = edit form, right = version history timeline
- Form fields: Category (select), Name (text), Global Guidance (large textarea), Coach Instructions (textarea), Draft Coach Instructions (textarea), Notes (textarea)
- 'Publish New Version' button creates immutable version (primary action)
- 'Archive Template' button with danger confirmation modal; shows pinned case count warning
- Version history shows each version with date + admin + notes + 'View' read-only button
- All operations are gated by ADMIN role check

### T39: Audit logging backend

**Type:** Task

**Summary:** Create the audit logging utility and admin/audit query. Every admin action (template create/publish/archive) writes to the auditLog table with actorUserId, action, targetType, targetId, metadata, createdAt. Admin-only query returns filterable audit log entries.

**Depends on:** T3, T5

**Acceptance Criteria:**

- writeAuditLog(ctx, { action, targetType, targetId, metadata }) utility inserts an auditLog row
- All admin template mutations call writeAuditLog with appropriate action strings (TEMPLATE_CREATED, TEMPLATE_PUBLISHED, TEMPLATE_ARCHIVED)
- admin/audit/list query returns audit log entries, filterable by actor and action type
- Query is admin-gated; throws FORBIDDEN for non-admins
- Each audit entry includes actorUserId, action, targetType, targetId, metadata (JSON), createdAt

### T40: Audit log admin UI

**Type:** Story

**Summary:** Build the audit log page at /admin/audit per DesignDoc §4.13. Filterable table showing Actor, Action, Target, Timestamp. Click row opens a drawer with the full JSON payload. Read-only.

**Depends on:** T8, T39

**Acceptance Criteria:**

- Audit log page renders a table: Actor (display name), Action, Target, Timestamp
- Table is filterable by actor and action type
- Click on row opens a side drawer with full JSON metadata payload
- Not editable — purely read-only view
- Page is gated by ADMIN role check
- Timestamps formatted in human-readable format

### T41: Cron job for abandoned case cleanup

**Type:** Task

**Summary:** Create convex/crons.ts with a daily cron that scans for JOINT_ACTIVE cases with no activity in 30 days and transitions them to CLOSED_ABANDONED per TechSpec §5.3.

**Depends on:** T7

**Acceptance Criteria:**

- Cron defined in convex/crons.ts using Convex's built-in scheduler
- Runs daily
- Finds all cases with status=JOINT_ACTIVE where updatedAt < 30 days ago
- Transitions matching cases to CLOSED_ABANDONED with closedAt timestamp
- Uses the state machine validateTransition for the status change
- No action taken on cases in other statuses

### T42: Seed data script (admin user + default templates)

**Type:** Task

**Summary:** Create convex/seed.ts per TechSpec §11.4. Admin-callable in dev only. Creates one admin user and 3 default templates (workplace, family, personal) each with a minimal globalGuidance. Used for local dev bootstrapping.

**Depends on:** T3, T37

**Acceptance Criteria:**

- convex/seed.ts is a Convex action callable from the Convex dashboard
- Creates one admin user with role=ADMIN if not already present
- Creates 3 default templates: workplace, family, personal — each with a minimal globalGuidance text
- Each template has an initial templateVersion published
- Idempotent: running twice does not create duplicates
- Guarded: only runs if NODE_ENV is development or CLAUDE_MOCK is true

### T43: Transcript compression

**Type:** Task

**Summary:** Implement the transcript compression logic per TechSpec §6.4. When total token count exceeds budget (60k for generation, 10k for classification), take oldest 50% of messages, call Haiku to summarize in ≤500 tokens, replace with synthetic SUMMARY message. Cache by content hash.

**Depends on:** T16, T17

**Acceptance Criteria:**

- Token counting utility estimates message token counts
- When context exceeds budget, oldest 50% of messages are selected for compression
- Haiku is called with compression prompt: 'Summarize this conversation segment in 500 tokens or fewer, preserving facts, decisions, emotional tone, and unresolved threads.'
- Compressed messages are replaced with a single SUMMARY: message in the context
- Summary is cached by content hash for reuse
- Budget thresholds: 60k tokens for user-facing generation, 10k for classification
- Compression integrates with assemblePrompt before passing context to Claude

### T44: Per-case AI cost budget tracking

**Type:** Task

**Summary:** Implement cost tracking per TechSpec §6.6. Track token usage per case via token counts × pricing. Soft cap at $2: degrade Coach to templated responses, admin notified. Hard cap at $10: disable AI features entirely, parties can still chat manually.

**Depends on:** T17, T39

**Acceptance Criteria:**

- Token counts from each AI call are recorded and accumulated per case
- Cost is estimated using token count × model pricing (Sonnet vs. Haiku rates)
- At $2 soft cap: inflammatory classification continues; Coach responds with templated boilerplate; admin notified via audit log
- At $10 hard cap: AI features fully disabled; parties exchange messages manually without Coach/Draft Coach/synthesis
- Cost check runs before each AI action and short-circuits if cap exceeded
- Current cost is queryable per case (for admin visibility)

### T45: CaseDetail routing component

**Type:** Task

**Summary:** Build the CaseDetail component at /cases/:caseId that reads case status and routes to the appropriate sub-view: private coaching, ready-for-joint, joint chat, or closed. Handles the case-context header in TopNav.

**Depends on:** T8, T11

**Acceptance Criteria:**

- CaseDetail reads case status via cases/get query
- Routes to PrivateCoachingView for DRAFT_PRIVATE_COACHING and BOTH_PRIVATE_COACHING
- Routes to ReadyForJointView for READY_FOR_JOINT
- Routes to JointChatView for JOINT_ACTIVE
- Routes to ClosedCaseView for CLOSED_* statuses
- TopNav shows case context header: 'Case with [other party] • [phase name]'
- Loading state shows skeleton layout while case data loads
- 404 if case not found or user is not a party to the case

### T46: Accessibility pass

**Type:** Task

**Summary:** Comprehensive accessibility audit and fixes per DesignDoc §7. Ensure WCAG 2.1 AA compliance: semantic landmarks, aria-live regions for chat, keyboard navigation, focus management on route/phase changes, focus trapping in modals, color contrast verification, prefers-reduced-motion support.

**Depends on:** T22, T27, T29, T31

**Acceptance Criteria:**

- Single <main> landmark per page, <nav> for navigation
- Chat regions use role='log' with aria-live='polite'
- Screen readers announce 'Coach is replying' once during streaming (not per character)
- All modals trap focus and restore on close
- Focus moves to page <h1> on route change
- Focus moves to new primary heading on phase change
- All buttons have visible labels or aria-label
- Focus rings: --accent, 2px outline + 2px offset, never removed
- Color contrast ≥ 4.5:1 verified for all text/background combinations
- prefers-reduced-motion disables streaming cursor animation, crossfades, and message fade-ins
- Keyboard-navigable throughout all critical paths

### T47: Error states, loading states, and empty states pass

**Type:** Task

**Summary:** Implement consistent error, loading, and empty states across all views per DesignDoc §6. Skeleton screens for loads >300ms, inline AI error messages with Retry, toast for network errors, friendly empty states for dashboard/chat/admin.

**Depends on:** T2, T12, T22, T27

**Acceptance Criteria:**

- Skeleton screens (not spinners) for dashboard load (3 case rows), case detail, and chat
- AI errors render inline as message bubbles with warning tint + Retry button per DesignDoc §6.2
- Network errors use toast notifications per DesignDoc §6.2
- Form errors render inline below the input
- Dashboard empty state: 'No cases yet. When you're ready to work through something, start a new case.'
- Admin templates empty: 'No templates yet. The app will use a built-in default baseline.'
- All error, loading, and empty states use design-token colors and consistent styling

### T48: Unit tests (Vitest) for core helpers

**Type:** Task

**Summary:** Write Vitest unit tests for pure helper functions: prompt assembly, transcript compression, token counting, privacy response filter (with adversarial prompts), state machine transitions, invite token generation, error code mapping.

**Depends on:** T7, T16, T18, T43

**Acceptance Criteria:**

- Vitest is configured and `npm run test:unit` passes
- Privacy response filter tests: true positives (verbatim matches ≥8 tokens), true negatives (paraphrased content passes), edge cases (short messages, empty input)
- State machine tests: all valid transitions succeed, all invalid transitions throw CONFLICT
- Prompt assembly tests: each role gets correct context and system prompt; no cross-party data leakage in PRIVATE_COACH context
- Token counting tests: reasonable estimates for various message lengths
- Transcript compression tests: output is ≤500 tokens, preserves key information
- Error code mapping tests: each code maps to correct HTTP status

### T49: Playwright E2E test infrastructure + Claude mock

**Type:** Task

**Summary:** Set up Playwright test infrastructure per TechSpec §10. Configure test-mode env var CLAUDE_MOCK=true with deterministic stub responder. Stub returns canned responses with configurable delays for streaming simulation. Set up test fixtures for user creation and auth.

**Depends on:** T1, T4

**Acceptance Criteria:**

- Playwright is installed and configured with playwright.config.ts
- CLAUDE_MOCK=true env var triggers stub AI responder in Convex actions
- Stub returns deterministic canned responses for each AI role (private coach, synthesis, joint coach, draft coach)
- Stub simulates streaming with configurable delays
- Test fixtures: createTestUser, loginAsUser, createTestCase helpers
- Base URL configured for local dev server
- npm run test:e2e runs Playwright tests

### T50: E2E test: solo full flow (highest-value test)

**Type:** Task

**Summary:** Write solo-full-flow.spec.ts per TechSpec §10.1 test 2. Create solo case, toggle to Initiator for private coaching + mark complete, toggle to Invitee for private coaching + mark complete, verify synthesis appears, enter joint chat, exchange messages with Draft Coach, propose + confirm closure, verify closed state.

**Depends on:** T33, T49

**Acceptance Criteria:**

- Test creates a solo case via the UI
- Toggles to Initiator: sends private coaching messages, marks complete
- Toggles to Invitee: sends private coaching messages, marks complete
- Verifies synthesis appears for both parties (toggling between them)
- Enters joint chat and exchanges messages
- Uses Draft Coach to draft and send a message
- Proposes closure with summary, toggles to confirm
- Verifies case appears in Closed section on dashboard
- Test passes end-to-end with mock Claude responses

### T51: E2E test: invite flow (two-user)

**Type:** Task

**Summary:** Write invite-flow.spec.ts per TechSpec §10.1 test 3. Two browser contexts: User A creates case and copies invite link, User B opens link, registers, accepts. Both see the case in their dashboards.

**Depends on:** T35, T49

**Acceptance Criteria:**

- Test uses two browser contexts (two separate users)
- User A creates a case and obtains the invite link
- User B opens invite link, registers/logs in, and accepts invitation
- User B fills their case form after accepting
- Both users see the case listed in their dashboards
- Case status transitions correctly: DRAFT_PRIVATE_COACHING → BOTH_PRIVATE_COACHING
- Consumed invite link shows error when reused

### T52: E2E test: draft coach send gate

**Type:** Task

**Summary:** Write draft-coach.spec.ts per TechSpec §10.1 test 4. Start a draft session, iterate with Draft Coach, verify 'Generate Draft' does NOT send to joint chat, verify only clicking 'Send' posts the message, discard a draft and verify it doesn't appear.

**Depends on:** T29, T49

**Acceptance Criteria:**

- Test starts a draft session via the Draft Coach panel
- Iterates with Draft Coach (sends messages, receives AI responses)
- Verifies that clicking 'Generate Draft' produces a draft but does NOT post to joint chat
- Verifies that clicking 'Send this message' posts the draft to joint chat
- Discards a draft session and verifies no message appears in joint chat
- Verifies 'Edit before sending' drops text into joint chat input without sending

### T53: E2E test: privacy security tests

**Type:** Task

**Summary:** Write privacy.spec.ts per TechSpec §10.1 test 5. As User B, attempt to read User A's private messages via direct query — must return FORBIDDEN. As admin, attempt same — must return FORBIDDEN. Verify Coach output in joint chat does not contain 8-token substrings from other party's private messages.

**Depends on:** T26, T49

**Acceptance Criteria:**

- Test verifies User B cannot access User A's private coaching messages (returns 403/FORBIDDEN)
- Test verifies admin cannot access either party's private coaching messages (returns 403/FORBIDDEN)
- Test verifies coach AI response in joint chat does not contain any 8-token substring from either party's private messages
- Test covers the cases/partyStates query: other party's form fields are not exposed
- All privacy violations result in clear FORBIDDEN errors, not empty results or silent failures

### T54: E2E test: admin template management

**Type:** Task

**Summary:** Write admin-templates.spec.ts per TechSpec §10.1 test 6. Admin creates template, publishes a version, edits to publish v2, verifies a pinned case still uses v1. Archive template and verify it's hidden from category picker but pinned cases still work.

**Depends on:** T38, T49

**Acceptance Criteria:**

- Test logs in as admin user
- Creates a new template with category and guidance
- Publishes initial version (v1)
- Edits and publishes v2; verifies both versions visible in history
- Creates a case pinned to v1; verifies case still uses v1 after v2 is published
- Archives the template; verifies it's hidden from the category picker
- Verifies the pinned case still functions correctly with the archived template

### T55: E2E test: state machine enforcement

**Type:** Task

**Summary:** Write state-machine.spec.ts per TechSpec §10.1 test 7. Attempt illegal transitions (send joint message when case in private coaching → CONFLICT), mark PC complete twice (idempotent), redeem consumed token (TOKEN_INVALID).

**Depends on:** T34, T49

**Acceptance Criteria:**

- Test verifies sending a joint message when case is in DRAFT_PRIVATE_COACHING fails with CONFLICT error
- Test verifies marking private coaching complete twice is idempotent (no error on second call)
- Test verifies redeeming a consumed invite token fails with TOKEN_INVALID error
- Test verifies entering joint chat before both parties complete PC fails
- Test verifies sending messages after case closure fails with CONFLICT

### T56: E2E test: auth flow

**Type:** Task

**Summary:** Write auth.spec.ts per TechSpec §10.1 test 1. Register new user via magic link (mock email capture), log out, log back in, verify Google OAuth flow (mocked).

**Depends on:** T10, T49

**Acceptance Criteria:**

- Test registers a new user via magic link with mocked email capture
- Verifies user record is created in the database
- Logs out and verifies session is cleared, redirects to login
- Logs back in via magic link and verifies session restoration
- Verifies Google OAuth flow (mocked provider)
- Verifies session persists across browser reload

### T57: CI pipeline (GitHub Actions)

**Type:** Task

**Summary:** Create GitHub Actions workflow per TechSpec §10.3. Four jobs: lint (ESLint + Prettier), typecheck (tsc --noEmit), unit tests (Vitest), E2E tests (Playwright with Convex dev deployment + mocked Claude). Runs on push and PR to main.

**Depends on:** T48, T49

**Acceptance Criteria:**

- GitHub Actions workflow file at .github/workflows/ci.yml
- lint job: runs ESLint + Prettier check
- typecheck job: runs tsc --noEmit
- unit job: runs Vitest
- e2e job: starts Convex dev deployment, runs Playwright with CLAUDE_MOCK=true
- Workflow triggers on push to main and on pull request
- All jobs run in parallel where possible (lint/typecheck/unit), e2e after they pass
- Playwright test results are uploaded as artifacts on failure
