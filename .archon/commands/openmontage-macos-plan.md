---
description: Analyze the OpenMontage repository for macOS-safe setup and write a setup plan artifact
argument-hint: <what kind of OpenMontage setup you want>
---

# OpenMontage macOS Analysis Plan

**Request**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Analyze the current OpenMontage repository as a macOS-targeted setup target.

Your job is to:
1. Read the repo's real setup and provider documents
2. Infer the requested setup profile from `$ARTIFACTS_DIR/request-profile.json`
3. Produce a concrete macOS setup plan that prefers local CPU-capable tooling first
4. Separate required local dependencies from optional API-driven providers
5. Write durable artifacts that downstream setup and summary steps can use

**Do not install anything in this command.** This phase is analysis and plan generation only.

---

## Phase 1: LOAD

Read these inputs first:

- `$ARTIFACTS_DIR/request-profile.json`
- `README.md`
- `AGENT_GUIDE.md`
- `Makefile`
- `.env.example`
- `requirements.txt`
- `docs/ARCHITECTURE.md`
- `docs/PROVIDERS.md`
- `remotion-composer/package.json`

Extract from `request-profile.json`:
- selected `action`
- selected `profile`
- selected `env_strategy`

### PHASE_1_CHECKPOINT
- [ ] Request profile loaded
- [ ] Core setup files read
- [ ] Provider and architecture docs read

---

## Phase 2: ANALYZE

Determine all of the following from the actual repo contents:

1. **Repo operating model**
   - confirm that OpenMontage is an agent-operated repository, not a turnkey packaged CLI app
   - identify the primary setup commands and validation entrypoints

2. **macOS-safe local baseline**
   - which pieces work locally on a normal Mac without CUDA
   - which pieces require only CPU + standard tools
   - which pieces should be treated as optional because they depend on NVIDIA/CUDA or external services

3. **Provider segmentation**
   - local CPU providers
   - API-backed providers
   - self-hosted endpoint options
   - local GPU-only paths that should be marked as non-default on macOS

4. **Environment strategy**
   - canonical env variable groups from `.env.example`
   - aliases that should be mentioned in guidance but normalized to one canonical key in scaffold output

5. **Recommended execution profile**
   - for `zero-key-cpu`, prefer FFmpeg + Remotion + Piper and avoid cloud assumptions
   - for `api-assisted`, keep the local baseline and add grouped optional API keys
   - for `self-hosted-cloud`, keep the local baseline and emphasize endpoint-backed options such as `MODAL_LTX2_ENDPOINT_URL`
   - for `custom`, keep the plan flexible and explain the tradeoffs

### PHASE_2_CHECKPOINT
- [ ] Required local tooling identified
- [ ] Optional API/tool groups identified
- [ ] macOS-specific warnings captured
- [ ] Profile recommendation justified

---

## Phase 3: GENERATE ARTIFACTS

Write these files under `$ARTIFACTS_DIR/`.

### 1. `$ARTIFACTS_DIR/openmontage-context.md`

Include:
- selected action/profile/env strategy
- one-paragraph summary of how OpenMontage is meant to be used
- table of required local tools for macOS
- table of optional provider groups and matching env vars
- explicit warning section for CUDA/NVIDIA-only flows
- list of validation entrypoints (`make setup`, `make preflight`, `make demo-list`, `make demo`, `make test-contracts`)

### 2. `$ARTIFACTS_DIR/openmontage-macos-plan.md`

Include:
- recommended setup profile and rationale
- ordered setup steps for macOS
- what the later bootstrap step should do automatically
- what it should never do automatically
- whether FFmpeg or other system dependencies still need manual install
- next-step matrix:
  - analyze-only
  - bootstrap
  - bootstrap-and-preflight

### 3. `$ARTIFACTS_DIR/openmontage-env-map.md`

Organize env keys into sections:
- image-video-gateway
- google
- voice
- music
- video-generation
- stock-media
- analysis
- avatar-local-paths

For each section, note:
- canonical variable names
- optional aliases supported by the codebase
- whether the variable is required for the selected profile

### PHASE_3_CHECKPOINT
- [ ] Context artifact written
- [ ] macOS plan artifact written
- [ ] env map artifact written

---

## Phase 4: REPORT

Provide a concise report that states:
1. the recommended macOS profile
2. the most important local-vs-cloud split
3. the most important risk for Apple Silicon / non-CUDA machines
4. which artifacts were written
