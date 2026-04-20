---
description: Create a grouped macOS-friendly env scaffold for OpenMontage without overwriting the user's existing .env
argument-hint: (no arguments - reads request profile from workflow artifacts)
---

# OpenMontage macOS Env Scaffold

**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Create a human-friendly env scaffold for macOS users of OpenMontage.

Rules:
- Do not overwrite `.env`
- Do not remove or rename existing project env files
- Prefer canonical variable names from `.env.example`
- Mention supported aliases in comments only
- Make the file useful for both zero-key local mode and API-assisted mode
- Treat `.env.macos.archon.example` as the preferred source file for creating a new `.env` later if the workflow bootstrap step needs one

Output file:
- `.env.macos.archon.example`

Also write an artifact summary to:
- `$ARTIFACTS_DIR/openmontage-env-scaffold.md`

---

## Phase 1: LOAD

Read:
- `$ARTIFACTS_DIR/request-profile.json`
- `$ARTIFACTS_DIR/openmontage-env-map.md`
- `.env.example`

Extract the selected profile and use it to annotate which sections are likely required vs optional.

### PHASE_1_CHECKPOINT
- [ ] Request profile loaded
- [ ] Env map loaded
- [ ] Existing .env.example reviewed

---

## Phase 2: GENERATE REPO FILE

Create `.env.macos.archon.example` with clear grouped sections in this order:

1. local-baseline
   - comments for `python3`, `npm`, `ffmpeg`, and `piper-tts` expectations
   - note that these are local prerequisites, not env vars

2. image-video-gateway
   - `FAL_KEY`

3. google
   - `GOOGLE_API_KEY`
   - comment that `GEMINI_API_KEY` is accepted by parts of the codebase, but this scaffold normalizes to `GOOGLE_API_KEY`

4. voice
   - `ELEVENLABS_API_KEY`
   - `OPENAI_API_KEY`
   - `XAI_API_KEY`

5. music
   - `SUNO_API_KEY`

6. video-generation
   - `HEYGEN_API_KEY`
   - `RUNWAY_API_KEY`
   - `VIDEO_GEN_LOCAL_ENABLED`
   - `VIDEO_GEN_LOCAL_MODEL`
   - `MODAL_LTX2_ENDPOINT_URL`
   - comment that `RUNWAYML_API_SECRET` and `FAL_AI_API_KEY` are alias forms in parts of the codebase

7. stock-media
   - `PEXELS_API_KEY`
   - `PIXABAY_API_KEY`
   - `UNSPLASH_ACCESS_KEY`

8. analysis
   - `HF_TOKEN`

9. avatar-local-paths
   - `WAV2LIP_PATH`
   - `SADTALKER_PATH`
   - add a warning comment that these flows are generally non-default on macOS unless the user has a compatible GPU setup

At the top of the file:
- state the selected profile from `$ARTIFACTS_DIR/request-profile.json`
- explain that zero-key local mode mainly needs FFmpeg + Remotion + Piper
- explain that `.env` can be copied from this file selectively instead of filling every key
- explain that if `.env` is missing, the workflow bootstrap may copy this file to `.env` as the safest macOS-oriented starting point

### PHASE_2_CHECKPOINT
- [ ] `.env.macos.archon.example` created
- [ ] Canonical keys used
- [ ] Alias guidance added as comments only

---

## Phase 3: GENERATE ARTIFACT

Write `$ARTIFACTS_DIR/openmontage-env-scaffold.md` with:
- file path of the scaffold created
- selected profile
- which sections are recommended for that profile
- reminder that `.env` was not overwritten by this command

### PHASE_3_CHECKPOINT
- [ ] Artifact written
- [ ] Non-destructive behavior documented

---

## Phase 4: REPORT

Report:
1. the scaffold file path
2. whether it targets zero-key local, API-assisted, or self-hosted emphasis
3. the most important manual follow-up for the user
