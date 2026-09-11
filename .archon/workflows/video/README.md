# Video workflow pack

Short-form vertical video production as governed workflows. Topic in, finished
1080x1920 MP4 out — narration, karaoke captions, and per-platform post copy —
stored, logged, and reviewable.

**It does not publish.** Runs stop at `store`.

| Workflow | For | Voice |
|---|---|---|
| `social-short` | General-interest, insight-driven shorts | Third person, essayistic. No CTA. |
| `ugc-video` | Testimonial / creator-style clips | First person, unpolished, keeps its caveats. No CTA. |
| `product-video` | Marketing a product | Problem-first, one benefit, names the product. **CTA allowed.** |
| `video-quality-review` | Craft review of a finished video | Human-gated; evolves the playbooks. |
| `video-render-block` | Building block — **not run directly** | Included by the three above. |

```bash
archon workflow run social-short  "Why cities can feel lonelier than small towns"
archon workflow run ugc-video     "I switched to a standing desk for 30 days"
archon workflow run product-video "<what it is, who it's for, the one benefit>"
archon workflow run video-quality-review        # reviews the most recent
```

## Setup — two keys and ffmpeg

The scripts read these from the **repo-root `.env`** (or Archon-managed
per-project env vars, which take precedence). They are deliberately not in this
repo's `.env`, so an unconfigured run fails immediately and by name:

```
PEXELS_API_KEY is not set (add it to /path/to/repo/.env)
```

| Variable | Service | Cost |
|---|---|---|
| `PEXELS_API_KEY` | https://www.pexels.com/api/ — stock footage | free |
| `CARTESIA_API_KEY` | https://cartesia.ai — TTS with word timestamps | ~$0.02–0.15/video |
| `CARTESIA_VOICE_ID` | optional voice override | — |

Also needs `ffmpeg` and `uv` on PATH. **No LLM key of its own** — script and copy
generation use whatever provider Archon is configured with, via the `large` and
`medium` tiers rather than pinned model names.

`video-quality-review` is the one exception: it pins `provider: claude` because
it must open the frame stills and judge them. Without a vision-capable provider
that node fails loudly, which is correct — the alternative is a text-only model
returning a confident verdict about images it never saw.

## Shape

```
read-strategy ─> gen-brief ─┬─> write-brief ──┐
                            └─> write-copy ─> save-copy ─┤
                                                         ▼
                                        include: video-render-block
                    fetch-clips ─┐
                    narrate ─> captions ─┴─> compose ─> qc ─> store
```

`video-render-block` makes no editorial decisions, which is why all three kinds
reuse it unchanged. It holds **no references** to the including workflow's nodes
— it reads `brief.json` and `copy.json` from `$ARTIFACTS_DIR` — so it survives
the `<includeId>__<nodeId>` renaming that include expansion applies, and works
on any provider.

## No transcription stage

Cartesia `sonic-3.5` returns word-level timestamps with the audio, so captions
are built from timings for a script already known verbatim. No Whisper model, no
STT bill, and no way for captions to disagree with the narration. Swapping TTS
for a provider without word timings brings that whole stage back.

## Per-kind playbooks

The review loop maintains **separate** playbooks per kind plus a shared one:

```
$STATE_DIR/content/
  strategy-common.md        craft mechanics only — caption legibility, audio, repetition
  strategy-social-short.md  }
  strategy-ugc.md           } voice, pacing, CTA policy, what copy may claim
  strategy-product.md       }
```

This is not incidental. The three kinds have deliberately opposing rules — a
first-person UGC clip and a benefit-led product ad disagree about hook, person,
and permitted claims — so a craft lesson from one is frequently wrong for
another. A single shared playbook let a product review silently rewrite the UGC
rules, and `strategy_version` incremented through both so attribution looked
clean while the content thrashed. The reviewer reads the kind from the video's
`meta.json` and declares `target: kind | common`; it writes exactly one file.

## Output

Nothing lands in this repo. Per-run scratch is `$ARTIFACTS_DIR`; the durable
library is `$STATE_DIR/content/videos/<run-id>/` with a `library.jsonl` ledger.
`store` stages to `<run-id>.partial` and moves into place, so a failure part-way
cannot leave a half-populated directory that looks stored.

## Authoring gotchas these workflows encode

- Media nodes **must** set `timeout:` — the subprocess default is 2 minutes and
  an encode blows through it in a way that reads like a hang.
- `worktree.enabled: false` is required, not an optimisation: `.env` is
  gitignored, so an isolated checkout would not contain the API keys.
- Consume an output ref as a **bare** shell word (`x=$node.output`). The engine
  already shell-quotes it; adding your own quotes, or pasting it into a heredoc,
  writes literal quote characters into the value.
- `WORKFLOW_ID` is a substitution variable. Export it before any Python that
  reads `os.environ` (see PR #2511, which also delivers it as a real env var).
- Don't put a tier keyword in `model:` on a node that pins `provider:` — the
  tier resolves its own provider and wins. Archon warns; read the warning.
- OpenAI-backed providers require `required` to list **every** property in an
  `output_format` schema.
