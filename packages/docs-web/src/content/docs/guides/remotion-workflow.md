---
title: Remotion 비디오 생성 워크플로
description: 노드별 skills와 bash render node를 사용해 AI로 Remotion video composition을 생성합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 9
---

`archon-remotion-generate` workflow는 AI를 사용해 Remotion video composition을 만듭니다. React/TypeScript code를 생성하고, preview stills를 render하고, full video를 render한 뒤 output을 요약합니다. 이 모든 과정은 노드별 skills를 사용하는 DAG workflow로 실행됩니다.

## 빠른 시작

### 1. Remotion project 생성

```bash
npx create-video@latest my-video
cd my-video
npm install
```

### 2. Remotion skill 설치(권장)

```bash
npx skills add remotion-dev/skills
```

이 명령은 official `remotion-best-practices` skill을 설치합니다(animations, audio, transitions, charts, 3D 등을 다루는 35개 rule files). workflow의 generate node는 더 높은 품질의 Remotion code를 만들기 위해 이 skill을 미리 로드합니다.

### 3. workflow 실행

```bash
# From your Remotion project directory:
bun run cli workflow run archon-remotion-generate "Create a 5-second countdown from 5 to 1 with bouncy spring animations and a glowing effect"
```

output은 `out/video.mp4`에 생성됩니다.

## 동작 방식

이 workflow는 5-node DAG입니다.

```
[check-project] → [generate] → [render-preview] → [render-video] → [summary]
     bash           agentic         bash               bash          agentic
                   + skill
```

| Node | Type | What It Does |
|------|------|-------------|
| `check-project` | bash | Remotion project structure(`src/index.ts`, `src/Root.tsx`)가 있는지 확인 |
| `generate` | agentic + skill | AI가 composition code를 작성/수정합니다. `remotion-best-practices` skill을 미리 로드합니다. |
| `render-preview` | bash | `npx remotion still`로 preview still 3개(early, mid, late frames)를 render |
| `render-video` | bash | H.264 codec으로 `npx remotion render`를 사용해 full MP4 render |
| `summary` | agentic (haiku) | code + stills를 읽고 무엇이 생성됐는지 설명 |

### 여기서 노드별 skills가 중요한 이유

`generate` node에는 `skills: [remotion-best-practices]`가 있습니다. 이 설정은 official Remotion skill을 agent context에 미리 로드해 다음 내용을 알려줍니다.

- 모든 animation에 `useCurrentFrame()` + `interpolate()`/`spring()` 사용
- CSS transitions, `Math.random()`, `setTimeout` 사용 금지
- native `<img>` 대신 `remotion`의 `<Img>` 사용
- scene timing에는 `<Sequence>`, auto-stacking에는 `<Series>` 사용
- transition에는 `fade()`, `slide()`와 함께 `<TransitionSeries>` 사용
- text, charts, Ken Burns zoom, staggered lists용 animation recipes
- `@remotion/media`의 `<Audio>`를 사용하는 audio integration patterns

skill이 없으면 agent가 Remotion에서 제대로 render되지 않을 수 있는 generic React code를 작성할 수 있습니다(CSS animations가 동작하지 않거나, `Math.random()`이 flickering을 유발하는 등).

### rendering에 bash node를 쓰는 이유

render node는 agentic node가 아니라 deterministic bash node입니다. 즉:

- LLM이 render step을 skip하거나 fake할 수 없습니다
- render errors는 hallucinated error가 아니라 실제 error입니다
- render time을 예측할 수 있습니다(token cost 없음)
- output file은 존재하거나 존재하지 않습니다. 모호함이 없습니다

이는 Stripe Minions의 "blueprint pattern"입니다. deterministic gate와 agentic node를 교차 배치해 pipeline을 안정적으로 유지합니다.

## Project Structure

workflow는 표준 Remotion project를 기대합니다.

```
my-video/
├── src/
│   ├── index.ts          # registerRoot(Root)
│   ├── Root.tsx           # <Composition> registration
│   └── MyVideo.tsx        # Your composition (AI modifies this)
├── public/                # Static assets (images, audio, fonts)
├── out/                   # Rendered output (created by workflow)
│   ├── preview-early.png  # Still at frame 1
│   ├── preview-mid.png    # Still at midpoint
│   ├── preview-late.png   # Still at 75% mark
│   └── video.mp4          # Final rendered video
└── package.json
```

## Prompt Tips

좋은 prompt는 code가 아니라 시각적 결과를 설명합니다.

```bash
# Good — describes what to see
bun run cli workflow run archon-remotion-generate "A 10-second animated bar chart showing monthly revenue growing from $10K to $100K, with each bar sliding up with a spring animation"

# Good — specific visual style
bun run cli workflow run archon-remotion-generate "Dark background, white text. Three slides: title card with company name, bullet points sliding in one by one, closing CTA with a pulse animation"

# Less good — too vague
bun run cli workflow run archon-remotion-generate "make a video"
```

## MCP Servers 추가

더 풍부한 workflow를 위해 skills와 MCP를 결합하세요. 예를 들어 agent가 API details를 조회할 수 있도록 Remotion docs MCP server를 추가할 수 있습니다.

```json
// .archon/mcp/remotion.json
{
  "remotion-docs": {
    "command": "npx",
    "args": ["@remotion/mcp@latest"]
  }
}
```

그런 다음 skill과 MCP를 모두 추가한 custom workflow를 만듭니다.

```yaml
name: remotion-with-docs
description: Generate video with Remotion docs MCP access
nodes:
  - id: generate
    prompt: "Create a video: $ARGUMENTS"
    skills:
      - remotion-best-practices
    mcp: .archon/mcp/remotion.json
    allowed_tools:
      - Read
      - Write
      - Edit
      - Glob
      - mcp__remotion-docs__*
```

## Customization

### output format 변경

default workflow를 fork하고 `render-video` bash node를 수정하세요.

```yaml
  - id: render-video
    bash: |
      COMP_ID=$(npx remotion compositions src/index.ts 2>&1 | grep -E '^\S' | head -1 | awk '{print $1}')
      # GIF output:
      npx remotion render src/index.ts "$COMP_ID" out/video.gif --codec=gif
      # ProRes (high quality):
      npx remotion render src/index.ts "$COMP_ID" out/video.mov --codec=prores --prores-profile=hq
      # WebM:
      npx remotion render src/index.ts "$COMP_ID" out/video.webm --codec=vp9
```

### review+refine loop 추가

stills를 확인하고 필요하면 refinement로 되돌아가는 review node로 workflow를 확장합니다.

```yaml
  - id: review
    prompt: |
      Review the rendered preview stills at out/preview-early.png, out/preview-mid.png,
      out/preview-late.png.

      Check:
      1. Is there visible content (not just a blank/black screen)?
      2. Does the content match the original request: $ARGUMENTS?
      3. Are animations visible (different content across frames)?

      Respond with only a JSON object.
    depends_on: [render-preview]
    output_format:
      type: object
      properties:
        pass:
          type: boolean
        issues:
          type: array
          items:
            type: string
      required: [pass, issues]
    allowed_tools:
      - Read

  - id: refine
    prompt: |
      The video review found issues. Fix the composition code.
      Issues: $review.output.issues
      Original request: $ARGUMENTS
    depends_on: [review]
    when: "$review.output.pass == false"
    skills:
      - remotion-best-practices
    allowed_tools:
      - Read
      - Write
      - Edit
```

## 제한사항

- **Remotion project 필요** — workflow는 기존 file을 수정하며 project를 처음부터 scaffold하지 않습니다. 먼저 `npx create-video@latest`를 실행하세요.
- **Local rendering only** — `npx remotion render`(headless Chromium)를 사용합니다. serverless rendering에는 Lambda를 직접 사용하세요.
- **audio generation 없음** — workflow는 visual composition을 생성합니다. AI-generated voiceover나 music이 필요하면 `remotion-media-mcp` server를 추가하세요.
- **Skill 설치 필요** — `remotion-best-practices` skill은 `npx skills add remotion-dev/skills`로 설치되어 있어야 합니다. 없어도 workflow는 실행되지만 code quality가 낮아질 수 있습니다.

## 관련 문서

- [노드별 Skills](/guides/skills/) — DAG node에서 `skills:`가 동작하는 방식
- [노드별 MCP Servers](/guides/mcp-servers/) — DAG node에서 `mcp:`가 동작하는 방식
- [Remotion Documentation](https://www.remotion.dev/docs) — official Remotion docs
- [Remotion Skills](https://github.com/remotion-dev/skills) — official skill repository
