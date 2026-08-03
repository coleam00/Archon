# Claude Code Workshop — Feature Coverage Matrix

**Host**: Rasmus | Thomas prepped the platform features section, Rasmus prepped the extensibility skills

---

## Coverage Matrix

| Feature | Thomas | Rasmus | Notes |
|---------|:------:|:------:|-------|
| **TIER 1 — Platform Features** | | | |
| Agent Teams (split panes, task list, delegate mode) | Y | — | Thomas only |
| Teammate-to-teammate messaging | Y | — | Thomas only |
| `--worktree` CLI flag | Y | — | Thomas demos CLI level |
| `isolation: worktree` in agent frontmatter | mention | Y | Rasmus demos in rulecheck agent |
| Desktop auto-worktree | Y | — | Thomas mentions |
| `/batch` (parallel codebase-wide changes) | Y | — | Thomas only |
| Remote Control (`/rc`, QR code, phone) | Y | — | Thomas only |
| Session Teleportation (`--remote`, `/tp`) | Y | — | Thomas only |
| **TIER 2 — Extensibility (Skills + Agents + Hooks)** | | | |
| Skills system (SKILL.md, frontmatter, slash menu) | — | Y | All 3 skills |
| Custom agents (`.claude/agents/`, agent frontmatter) | — | Y | rulecheck, triage |
| `context: fork` (isolated subagent context) | — | Y | rulecheck, triage |
| `agent:` delegation (skill -> custom agent) | — | Y | rulecheck, triage |
| `disable-model-invocation: true` | — | Y | All 3 skills |
| `argument-hint` | — | Y | rulecheck, triage |
| `allowed-tools` + wildcards (`Bash(gh *)`) | — | Y | triage |
| `!`command`` dynamic context injection | — | Y | All 3 skills |
| `$ARGUMENTS` variable substitution | — | Y | All 3 skills |
| `${CLAUDE_SESSION_ID}` | — | Y | rulecheck, save-task-list |
| Supporting files (lazy-loaded markdown) | — | Y | rulecheck |
| `background: true` (concurrent execution) | — | Y | rulecheck |
| `memory: project` (persistent agent memory) | — | Y | rulecheck |
| `permissionMode: acceptEdits` | — | Y | rulecheck |
| `maxTurns` safety cap | — | Y | rulecheck |
| `model:` per-agent override | — | Y | rulecheck, triage |
| **TIER 3 — Hooks** | | | |
| Hooks: `type: command` (shell scripts) | — | Y | rulecheck |
| Hooks: `type: prompt` (LLM-as-guardrail) | — | Y | save-task-list, triage |
| Hooks: `type: agent` (subagent evaluator) | — | Y | rulecheck (meta-judge) |
| Hooks: `type: http` | — | — | Neither covers |
| Hook scoping: skill-scoped (frontmatter) | — | Y | save-task-list |
| Hook scoping: agent-scoped (agent frontmatter) | — | Y | rulecheck, triage |
| Hook scoping: settings-level (cross-session) | — | Y | save-task-list (SessionStart) |
| `once: true` hook modifier | — | Y | save-task-list |
| `statusMessage` (custom spinner text) | — | Y | All 3 skills |
| `matcher` (hook event filtering) | — | Y | All 3 skills |
| PreToolUse hooks (safety gate) | — | Y | rulecheck |
| PostToolUse hooks | — | Y | All 3 skills |
| Stop hooks | — | Y | rulecheck, save-task-list |
| SessionStart hooks | — | Y | save-task-list |
| Inter-hook communication (summary file) | — | Y | rulecheck |
| **TIER 4 — Minor / Utility** | | | |
| `IS_DEMO=1` (hide email in UI) | Y | — | Thomas pre-setup |
| `/fast` toggle | mention | — | Thomas quick ref |
| `/plan` mode | mention | — | Thomas quick ref |
| `/rename` sessions | Y | — | Thomas + remote control |
| `/tasks` monitoring | Y | — | Thomas + teleportation |
| `/simplify` | mention | — | Thomas mentions in /batch context |
| Auto-Memory (`/memory`) | — | — | Neither demos standalone |
| Plugin system | — | — | Neither covers |
| `ConfigChange` hook event | — | — | Neither covers |
| `user-invocable: false` | — | mention | Rasmus mentions in table, not demoed |

---

## Not Covered — Gap Assessment

| Feature | What it is | Why it's useful | Can it fold into existing content? |
|---------|-----------|-----------------|-----------------------------------|
| **HTTP hooks** (`type: http`) | 4th hook type. POSTs JSON to a URL, receives JSON back. Supports custom headers with env var interpolation. | Enterprise integration — centralized validation services, CI pipelines, logging endpoints, security policy servers. Completes the "4 hook types" story. | **Yes — rulecheck.** Replace or add alongside the Slack shell script with an HTTP hook that POSTs to the same webhook URL. One line in agent frontmatter instead of a bash script. Shows the progression: command hook (complex) vs http hook (simple) for the same outcome. |
| **`/simplify`** | Built-in skill that spawns 3 parallel review agents (code reuse, code quality, efficiency). Auto-fixes issues in changed files. | Not a linter — 3 agents that understand project context and CLAUDE.md rules. Run after every feature. | **Yes — Thomas `/batch` section.** Already mentioned that /batch runs /simplify per unit. Add a 2-min standalone demo: make a change, run `/simplify`, show the 3 agents. Natural lead-in before /batch. |
| **Auto-Memory** (`/memory`) | Claude auto-saves useful context (build commands, test conventions, patterns) to memory. Survives compaction. Shared across worktrees. | Claude learns your project across sessions without manual CLAUDE.md maintenance. Worktree sharing means parallel agents benefit too. | **Yes — rulecheck.** The rulecheck agent already uses `memory: project`. After the demo, show `/memory` to view what Claude saved globally. 30-second addition. |
| **Plugin system** | Custom npm registries, version pinning, git-based plugins, auto-update toggle, plugin-provided commands/agents/hooks. Marketplace infrastructure. | Sharing skills/agents/hooks across teams and projects. Community ecosystem. | **No — separate topic.** Too large and different in character. Would need its own 10-min section. Skip for this workshop. |
| **`ConfigChange` hook event** | Fires when configuration files change during a session. Can block changes. | Enterprise security auditing — detect and optionally block settings modifications mid-session. | **Mention only.** Could add one slide: "There's also ConfigChange for enterprise security auditing" during the hooks overview. Not worth a live demo. |
| **`user-invocable: false`** | Skills only invocable by Claude (auto-invoke), not by the user via slash command. Opposite of `disable-model-invocation`. | Internal utility skills that Claude calls when needed but users shouldn't trigger directly. | **Yes — Rasmus save-task-list.** Already mentioned in the comparison table. Add one sentence: "The inverse exists too — `user-invocable: false` hides a skill from the slash menu but lets Claude call it automatically." |
| **`/debug`** | Troubleshooting command for the current session. | Useful when things go wrong — inspect session state, config, tool availability. | **Mention in Q&A.** Not worth demo time but good to know about. |
| **`/fork`** | Branch a conversation into a new session. | Explore alternative approaches without losing the current thread. | **No.** Useful but tangential. Skip. |
| **`/resume` + `/rename`** | Resume past sessions (up to 50), name sessions for easy finding. | Session management for long-running work. Thomas covers `/rename` with remote control. | **Already partially covered** by Thomas (rename). `/resume` could be a 30-sec mention. |
| **PDF page ranges** (`pages` param on Read) | Read specific pages of large PDFs instead of entire document. | Useful for spec-heavy projects. | **No.** Too niche for this workshop. |
| **Terminal shortcuts** (Shift+Enter, Ctrl+B, Ctrl+F, Alt+P) | Shift+Enter multi-line input, Ctrl+B background, Ctrl+F kill agents, Alt+P switch model. | Daily productivity. Thomas covers some in Agent Teams context. | **Quick reference card only.** Add to the printed card, don't demo. |
| **Wildcard tool permissions in settings** (`Bash(npm *)`) | Broader permission patterns in settings.json, fewer rules needed. | Reduces permission fatigue for trusted commands. | **Yes — triage.** Already shows `Bash(gh *)` in skill frontmatter. Mention that the same patterns work in settings.json for global use. One sentence. |
| **Vim motions** (`;`, `,`, `y/yy/Y`, `p/P`, text objects) | Vim-style editing in the Claude Code input buffer. | Power users. | **No.** Too niche, skip. |
| **`IS_DEMO=1`** | Hides email and organization from UI for streaming/recording. | Privacy during live demos. | **Already covered** in Thomas pre-setup. |

### Recommendation Summary

| Action | Features |
|--------|----------|
| **Fold in (easy, <2 min each)** | HTTP hooks (rulecheck), /simplify (Thomas), auto-memory (rulecheck), `user-invocable: false` (save-task-list), wildcard permissions note (triage) |
| **Mention only (one sentence)** | ConfigChange, /debug, /resume, vim motions |
| **Skip for this workshop** | Plugin system, /fork, PDF pages, terminal shortcuts (add to ref card) |

---

## Summary

- **Thomas**: 5 platform features (Agent Teams, Worktrees, /batch, Remote Control, Teleportation)
- **Rasmus**: 3 skills demonstrating ~25 extensibility features (skills, agents, hooks, memory, isolation)
- **Overlap**: Worktree isolation (different entry points — CLI vs agent frontmatter)
- **Gaps**: HTTP hooks, /simplify standalone, plugin system, ConfigChange, auto-memory
