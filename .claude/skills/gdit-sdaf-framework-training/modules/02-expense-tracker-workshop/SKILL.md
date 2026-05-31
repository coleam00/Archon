---
name: expense-tracker-workshop
description: 90-minute hands-on workshop building a Python CLI expense tracker using the full GDIT spec-driven workflow. Covers spec review, validation, test-driven development, implementation with security scans, and two-layer verification. Can be taken independently or after the Kiro IDE workshop.
license: MIT
compatibility: Requires GDIT Spec-Driven AI Framework installed, Python 3.12+, pytest
---

# Expense Tracker Workshop

90-minute hands-on workshop that teaches the GDIT spec-driven workflow by building a Python CLI expense tracker from pre-built specs.

## Prerequisites

- Kiro IDE or kiro-cli installed
- Python 3.12+
- Git
- GDIT Spec-Driven AI Framework installed
- pytest installed

## What Participants Build

A Python CLI expense tracker with 3 commands (add, list, summary) using only stdlib — no AWS account or external dependencies needed.

## Workshop Flow

1. Intro — What The GDIT framework adds on top of Kiro (10 min)
2. Spec Review — Walk through pre-built expense tracker specs (15 min)
3. Validate Spec — Run quality gates (5 min)
4. Generate Tests — AI derives tests from acceptance criteria (10 min)
5. Implement — AI implements tasks 1-3 with protocol headers, scans, checkpoints (30 min)
6. Verify — Two-layer verification producing VERIFICATION.md (10 min)
7. Wrap-Up — Value tracking results, key takeaways (10 min)

## Materials

Workshop materials are in the project repo at `docs/training/framework-training-workshop/`:
- `agenda.md` — Workshop schedule
- `exercise-instructions.md` — Step-by-step participant guide
- `facilitator-guide.md` — Timing, talking points, troubleshooting
- `specs/expense-tracker/` — Pre-built specs
- `scripts/verify-setup.py` — Prerequisites checker
