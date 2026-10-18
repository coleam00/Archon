<p align="center">
  <img src="assets/logo.png" alt="Archon" width="160" />
</p>

<h1 align="center">Archon</h1>

> 本文件是 [README.md](README.md) 的简体中文翻译。代码块、命令、YAML、架构图、事件名与包/工作流名称等保持原文；专有名词（Archon、workflow、worktree、provider、Web UI、CLI、telemetry 等）保留英文。

<p align="center">
  面向 AI 编程的第一个开源 harness 构建器。让 AI 编程变得确定、可复现。
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/13964" target="_blank"><img src="https://trendshift.io/api/badge/repositories/13964" alt="coleam00%2FArchon | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/coleam00/Archon/actions/workflows/test.yml"><img src="https://github.com/coleam00/Archon/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://archon.diy/docs/"><img src="https://img.shields.io/badge/docs-archon.diy-blue" alt="Docs" /></a>
</p>

---

Archon 是一个面向 AI 编程 agent 的工作流引擎。把你的开发流程定义成 YAML 工作流——规划、实现、校验、代码评审、创建 PR——并在你的所有项目中可靠地运行它们。

正如 Dockerfile 之于基础设施、GitHub Actions 之于 CI/CD，Archon 面向的是 AI 编程工作流。可以把它想成软件研发领域的 n8n。

## 为什么选择 Archon？

当你让一个 AI agent 去“修复这个 bug”时，会发生什么取决于模型当下的心情。它可能会跳过规划，可能忘记跑测试，可能写出一份无视你模板的 PR 描述。每一次运行都不一样。

Archon 解决了这一点。把你的开发流程编码成一个工作流。工作流定义了各个阶段、校验关卡与产出物。AI 在每一步填入其智能，但结构是确定的，并且由你掌控。

- **可复现（Repeatable）** - 同样的工作流，同样的顺序，每次如此。规划、实现、校验、评审、PR。
- **Worktree 隔离（Worktree isolation）** - 仓库工作流可以在一个独立的 git worktree 中运行，也可以复用已有的一个。参见 [isolation and folder projects](https://archon.diy/getting-started/concepts/#isolation-worktrees)。
- **即发即忘（Fire and forget）** - 启动一个工作流，去做别的事。回来时就是一个带着评审意见的、已完成的 PR。
- **可组合（Composable）** - 将确定性节点（bash 脚本、测试、git 操作）与 AI 节点（规划、代码生成、评审）混合编排。AI 只在它能带来价值的地方运行。
- **可移植（Portable）** - 在 `.archon/workflows/` 中一次性定义工作流，并提交到你的仓库。无论是从 CLI、Web UI、Slack、Telegram 还是 GitHub，它们的行为都完全一致。

## 它长什么样

下面是一个 Archon 工作流示例：它会先规划，然后在循环中不断实现直到测试通过，取得你的批准后，再创建 PR：

```yaml
# .archon/workflows/build-feature.yaml
nodes:
  - id: plan
    prompt: "Explore the codebase and create an implementation plan"

  - id: implement
    depends_on: [plan]
    loop:                                      # AI loop - iterate until done
      prompt: "Read the plan. Implement the next task. Run validation."
      until: ALL_TASKS_COMPLETE
      fresh_context: true                      # Fresh session each iteration

  - id: run-tests
    depends_on: [implement]
    bash: "bun run validate"                   # Deterministic - no AI

  - id: review
    depends_on: [run-tests]
    prompt: "Review all changes against the plan. Fix any issues."

  - id: approve
    depends_on: [review]
    loop_group:                                # Repeat until approved
      max_iterations: 5
      until_bash: 'decision=$ask.output.decision; [ "$decision" = approve ]'
      nodes:
        - id: revise
          prompt: "Address this feedback, if any: $LOOP_PREV.ask.output.text"
        - id: ask
          depends_on: [revise]
          wait:                                # Pauses until you approve or reject
            attention: "Review the changes. Approve, or reject with what to change."
            form: approval

  - id: create-pr
    depends_on: [approve]
    prompt: "Push changes and create a pull request"
```

告诉你的编程 agent 你想要什么，剩下的交给 Archon：

```
You: Use archon to add dark mode to the settings page

Agent: I'll run the archon-ship workflow for this.
       → Creating isolated worktree on branch archon/task-dark-mode...
       → Triage: needs a plan
       → Planning...
       → Implementing...
       → Tests failing - iterating...
       → Tests passing after 2 iterations
       → Draft PR opened, review complete - 0 blocking findings
       → PR ready: https://github.com/you/project/pull/47
```

## 早期版本

在找最初基于 Python 的 Archon（任务管理 + RAG）吗？它被完整地保留在 [`archive/v1-task-management-rag`](https://github.com/coleam00/Archon/tree/archive/v1-task-management-rag) 分支上。

## 开始使用

> **大多数用户应从[完整安装（Full Setup）](#full-setup-5-minutes)开始**——它会引导你完成凭证配置，把 Archon 技能安装进你的项目，并给你 Web 控制台。
>
> **已经装好 Claude Code、只想要 CLI？** 直接跳到[快速安装（Quick Install）](#quick-install-30-seconds)。

<a name="full-setup-5-minutes"></a>
### 完整安装（5 分钟）

克隆仓库并使用引导式安装向导。它会配置凭证、平台集成，并把 Archon 技能复制进你的目标项目。

<details>
<summary><b>前置条件（Prerequisites）</b> - Bun、Claude Code 与 GitHub CLI</summary>

**Bun** - [bun.sh](https://bun.sh)

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
```

**GitHub CLI** - [cli.github.com](https://cli.github.com/)

```bash
# macOS
brew install gh

# Windows (via winget)
winget install GitHub.cli

# Linux (Debian/Ubuntu)
sudo apt install gh
```

**Claude Code** - [claude.ai/code](https://claude.ai/code)

```bash
# macOS/Linux/WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

</details>

```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
claude
```

然后说：**“Set up Archon”**

安装向导会带你走完全部流程：CLI 安装、身份认证、平台选择，并把 Archon 技能复制到你的目标仓库。

<a name="quick-install-30-seconds"></a>
### 快速安装（30 秒）

已经配置好 Claude Code？安装独立 CLI 二进制，跳过向导。

**macOS / Linux**
```bash
curl -fsSL https://archon.diy/install | bash
```

> **x64 兼容性：** macOS/Linux 的快速安装要求 x64
> CPU 支持 AVX2。较老的 Intel/AMD 硬件，以及屏蔽了 AVX2 的虚拟机，应改用
> [源码安装指南](https://archon.diy/getting-started/installation/#from-source)。
> ARM64 的快速安装不受影响。

**Windows (PowerShell)**
```powershell
irm https://archon.diy/install.ps1 | iex
```

**Homebrew**
```bash
brew install coleam00/archon/archon
```

发行版二进制默认不附带 AI provider。快速安装器会询问要安装
Claude、Codex 和 Pi 中的哪些；传入 `--providers codex`（shell）或
`-Providers codex`（PowerShell）即可跳过该提问。Homebrew 安装之后，
或想要稍后添加某个 provider 时，运行 `archon setup` 或 `archon provider add <claude|codex|pi>`。
参见 [Installation → Providers](https://archon.diy/getting-started/installation/#providers)。

> **Claude provider 需要 Claude Code。** 编译好的二进制并不打包它。
> 请单独安装；如果 Archon 找不到它，就手动指过去：
>
> ```bash
> # macOS / Linux / WSL
> curl -fsSL https://claude.ai/install.sh | bash
> export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"
>
> # Windows (PowerShell)
> irm https://claude.ai/install.ps1 | iex
> $env:CLAUDE_BIN_PATH = "$env:USERPROFILE\.local\bin\claude.exe"
> ```
>
> 或者在 `~/.archon/config.yaml` 中设置 `assistants.claude.claudeBinaryPath`。
> Docker 镜像已预装 Claude Code。细节参见 [AI Assistants → Binary path configuration](https://archon.diy/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only)。

### 开始使用 Archon

完成上述任一安装路径后，进入你的项目并开始工作：

```bash
cd /path/to/your/project
claude
```

```
Use archon to fix issue #42
```

```
What archon workflows do I have? When would I use each one?
```

编程 agent 会替你处理工作流选择、分支命名与 worktree 隔离。项目会在第一次被使用时自动注册。

> **重要：** 始终在你的目标仓库中运行 Claude Code，而不是在 Archon 仓库里。安装向导会把 Archon 技能复制进你的项目，使其从那里工作。

## Web UI

Archon 自带一个 Web 控制台，用于运行工作流、检查运行记录，以及与你的编程 agent 对话。无论以哪种方式安装，都运行 `archon serve` 来启动它。二进制版本会在首次运行时下载匹配的 Web UI；源码检出版本会提供你自行构建的那份：先在仓库根目录运行一次 `bun run build:web`，然后 `archon serve`。

在项目栏中点击 **Add project** 注册一个项目，然后输入一个 GitHub URL 或本地路径。选中该项目即可发起一次运行或打开它的对话。

**主要页面：**
- **Runs（运行）** - 全部运行与按项目划分的运行，带状态筛选与实时进度
- **Run detail（运行详情）** - 事件日志、产出物、在有项目上下文时显示工作流图，以及适用的治理操作
- **Project chat（项目对话）** - 所选项目的实时助手文本与工具活动
- **Settings（设置）** - provider 凭证、模型层级与别名、助手默认值、系统状态与 GitHub 身份
- **Workflow builder（工作流构建器）** - 针对有限一组工作流节点表单的实验性可视化编排

完整文档参见 [Web UI Guide](https://archon.diy/adapters/web/)。

## 你能自动化什么？

Archon 为软件研发生命周期内置了 `sdlc` 工作流包：

| 工作流 | 作用 |
|----------|-------------|
| `archon-ship` | issue 或请求 → 分诊 → 调查或规划 → 交付一个经过评审的 PR |
| `archon-triage` | 对照当前代码检查一个 issue，并决定它下一步需要什么 |
| `archon-investigate` | 证实某个 bug 或悬而未决问题的根因，并写出一份报告 |
| `archon-plan` | 把已决定的意图转化为一份可实现的计划 |
| `archon-implement` | 持续构建已决定的工作，直到项目的各项检查通过；提交，不建 PR |
| `archon-pr` | 为当前分支上已提交的工作打开一个 pull request |
| `archon-deliver` | 实现 → 草稿 PR → 评审 → 修复发现 → 校验 → CI → 可评审 |
| `archon-review` | 通过并行的专家视角评审一个 PR 或工作区 diff |
| `archon-validate` | 运行项目自身的各项检查，并报告一个结构化的结论 |
| `archon-upkeep` | 通过带评审的交付尾部更新某一个依赖 |

运行 `archon workflow list` 查看它们，或描述你想要的东西，由路由器挑选合适的那一个。对于普通问题，尽管问：路由器会直接作答。

较早的 `archon-*` 工作流（`archon-fix-github-issue`、`archon-idea-to-pr`、`archon-smart-pr-review`、`archon-assist` 以及其他）已不再随发行版提供。若想继续使用其中某个，请从 [`.archon/workflows/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/workflows/defaults)（大多位于其 `legacy/` 目录）把它复制进你项目的 `.archon/workflows/`，并把它所用的 [commands](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/commands/defaults) 一并复制到 `.archon/commands/`。`archon-idea-to-pr`、`archon-plan-to-pr` 与 `archon-issue-review-full` 还需要同一 `legacy/` 目录里的 `archon-review-block.yaml`，因为它们会引用它。请把该副本另存为一个不同的名字，例如 `legacy-review-block`（其文件名与其 `name:` 都要改），并把这三个工作流的 `include:` 指向它：`sdlc` 包自带了自己的 `archon-review-block`，而一个同名的项目级或全局副本会将其替换掉。

**或者定义你自己的。** 想让工作流可复制，就把它的 YAML、commands 与 scripts 一起放在 `.archon/workflows/<pack>/<workflow>/` 下；这两个目录名都由你决定。同样的目录树在目标仓库中、以及在 `~/.archon/workflows/` 下都能工作。已有的扁平工作流以及共享的 `.archon/commands/` / `.archon/scripts/` 仍受支持。你仓库中与内置默认同名的工作流文件会覆盖内置默认。

参见 [Authoring Workflows](https://archon.diy/guides/authoring-workflows/) 与 [Authoring Commands](https://archon.diy/guides/authoring-commands/)。

## 添加平台

Web UI 与 CLI 开箱即用。可选地接入一个聊天平台以实现远程访问：

| 平台 | 配置耗时 | 指南 |
|----------|-----------|-------|
| **Telegram** | 5 分钟 | [Telegram Guide](https://archon.diy/adapters/telegram/) |
| **Slack** | 15 分钟 | [Slack Guide](https://archon.diy/adapters/slack/) |
| **GitHub Webhooks** | 15 分钟 | [GitHub Guide](https://archon.diy/adapters/github/) |
| **Discord** | 5 分钟 | [Discord Guide](https://archon.diy/adapters/community/discord/) |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  Platform Adapters (Web UI, CLI, Telegram, Slack,       │
│                    Discord, GitHub)                     │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Orchestrator                        │
│          (Message Routing & Context Management)         │
└─────────────┬───────────────────────────┬───────────────┘
              │                           │
      ┌───────┴────────┐          ┌───────┴────────┐
      │                │          │                │
      ▼                ▼          ▼                ▼
┌───────────┐  ┌────────────┐  ┌──────────────────────────┐
│  Command  │  │  Workflow  │  │    AI Assistant Clients  │
│  Handler  │  │  Executor  │  │   (Claude / Codex / Pi)  │
│  (Slash)  │  │  (YAML)    │  │                          │
└───────────┘  └────────────┘  └──────────────────────────┘
      │              │                      │
      └──────────────┴──────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│          SQLite / PostgreSQL (14 core tables)           │
│  Codebases • Conversations • Sessions • Workflow Runs   │
│   Isolation Environments • Messages • Workflow Events   │
│    Users • User Identities • Workflow Node Sessions     │
│         Codebase Env Vars • User GitHub Tokens          │
│           User Provider Keys • User AI Prefs            │
│          (+ Better Auth tables, Postgres only)          │
└─────────────────────────────────────────────────────────┘
```

## 文档

完整文档可在 **[archon.diy/docs](https://archon.diy/docs/)** 找到。

| 主题 | 说明 |
|-------|-------------|
| [Getting Started](https://archon.diy/getting-started/overview/) | 安装指南（Web UI 或 CLI） |
| [The Book of Archon](https://archon.diy/book/) | 10 章叙事式教程 |
| [CLI Reference](https://archon.diy/reference/cli/) | 完整的 CLI 参考 |
| [Authoring Workflows](https://archon.diy/guides/authoring-workflows/) | 创建自定义 YAML 工作流 |
| [Authoring Commands](https://archon.diy/guides/authoring-commands/) | 创建可复用的 AI 命令 |
| [Configuration](https://archon.diy/reference/configuration/) | 全部配置项、环境变量、YAML 设置 |
| [AI Assistants](https://archon.diy/getting-started/ai-assistants/) | Claude、Codex 与 Pi 的安装细节 |
| [Deployment](https://archon.diy/deployment/) | Docker、VPS、生产环境部署 |
| [Architecture](https://archon.diy/reference/architecture/) | 包总览与受维护的架构图 |
| [Troubleshooting](https://archon.diy/reference/troubleshooting/) | 常见问题与解决办法 |

**面向 AI 工具：** 让你的 LLM 读取 [`/llms.txt`](https://archon.diy/llms.txt) 以获取全部文档索引，读取 [`/llms-full.txt`](https://archon.diy/llms-full.txt) 以获取单文件版完整文档，或读取 [`/llms-small.txt`](https://archon.diy/llms-small.txt) 以获取精简版。

## 遥测（Telemetry）

Archon 会发送少量匿名事件，以便维护者了解哪些工作流有真实使用量、在哪些平台上使用、以及运行是否成功——并据此排定优先级。**绝无 PII（个人身份信息）。** 事件包括：`archon_started`（每次 CLI 调用或服务器启动一次；`archon serve` 作为服务器上报，而一个被分离运行的 worker 进程由启动它的那条命令计入）、`archon_active`（服务器运行期间的每日心跳，使长期运行的安装始终被计入）、`chat_turn_handled`（每一次直接的 AI 对话轮次——平台、provider、模型、耗时与用量合计；绝不含消息内容）、`workflow_invoked`（每次工作流启动，以及每个恢复的分段再各一次）、`workflow_completed` / `workflow_failed` / `workflow_cancelled`（当一次运行的最终状态被保存时各发送一次，无论它以哪条路径结束）、`workflow_approval_resolved`（每一次人工批准/拒绝的决定——仅有二元的结果，绝不含评论或理由），以及 `codebase_registered`（一个项目被注册时仅是一个纯计数——不含名称、路径或 URL）。

**采集了什么（仅分类信息）：**
- **工作流名称** - 对*内置*（Archon 编写）的工作流发送其真实名称；对你自己的工作流发送 `"custom"`，因此私密名称绝不会离开你的机器。发现来源（`bundled`/`global`/`project`/`installed`）会一并发出。
- **运行的形态与结果** - 平台（`cli`/`web`/`slack`/…）、provider 与模型 id、节点数量、各类节点各有多少、图深度与最大扇出、引用了多少个不同的命令、内联 prompt 总量以分桶表示（`none`/`lt_1k`/`1k_5k`/`5k_20k`/`gte_20k` 字符）、用到了哪些节点类型与特性（loop/approval/script/bash、结构化输出、持久化会话、MCP、skills、fresh-context 循环）、该运行是否为交互式、是否在 worktree 中隔离、是否为恢复、或是否为另一次运行的子运行，其结果，耗时（从运行的首次启动到其结束，包含审批与等待时间），一个分类的退出或取消原因，以及在首个失败节点失败处记录的固定枚举失败类别（provider 错误时为 `fatal`/`transient`/`unknown`/`rate_limited`/`overloaded`；引擎检测到的原因则为 `timeout`、`exec_failed`、`output_contract`、`max_iterations`、`child_failed`、`cancelled`、`config`——绝不含原始错误文本）加上该节点的类型。
- **运行引用** - `run_ref`，即安装 UUID 与运行 id 的一个单向哈希，以便把一次运行的启动、恢复与结果关联起来。运行 id 本身从不发送。
- **内置来源关系** - 当你某个工作流是某个内置工作流的副本时，发送该内置工作流的名称，以及该副本是 `identical` 还是 `modified`（`derived_from`、`derived_similarity`）。仅发送内置的名称；关于你副本的名称、节点 id 或 prompt 一概不发。
- **聊天活动** - 每一轮直接对话的 AI 一个事件，含平台、provider、模型、耗时与 completed/failed；某一轮次若 provider 在轮次中途报错则计为 failed。消息内容、prompt 与对话 id 从不发送。
- **聚合用量** - provider 上报的总输入、输出、可选的缓存读/缓存写 token 合计（当这些合计仅为下界时会带一个标记），以及每次工作流运行（跨其所有恢复分段）的花费（美元）（父运行的总量包含其子运行的开销，因此对花费求和时只累加那些不是子运行的运行），外加直接对话用量与总循环次数。仅为数值合计——绝不含 token 所代表的内容。
- **机器上下文** - 操作系统、架构、Archon 版本、运行时、是否为二进制构建、安装渠道（`binary`/`docker`/`source`）、当前运行构建的短 commit（若可知）、stderr 是否为终端，以及一个 CI 标记。
- **部署形态**（仅服务器）- 启用了哪些适配器（布尔值）、数据库类型（`sqlite`/`postgresql`）、是否开启了 Web 鉴权与多用户模式，以及 GitHub 鉴权模式。配置*值*（令牌、URL、主机）从不发送。
- 一个随机安装 UUID，存储于 `$ARCHON_HOME/telemetry-id`（默认 `~/.archon/telemetry-id`，在 Docker 中为 `/.archon/telemetry-id`）。仅此而已。
- 每个事件上的一个 `schema_version` 号，会在上述清单变化时递增。

**未采集什么：** 你的代码、prompt、消息、自定义工作流名称、工作流描述、git 远程地址、文件路径、用户名、令牌、AI 输出、错误消息文本、你的 IP 地址、你的地理位置——统统不采。

**选择退出：** 在环境中设置以下任意一项：

```bash
ARCHON_TELEMETRY_DISABLED=1
DO_NOT_TRACK=1        # de facto standard honored by Astro, Bun, Prisma, Nuxt, etc.
POSTHOG_API_KEY=off   # off | 0 | false | disabled | "" all disable
```

CI 环境（`CI=true`）会自动禁用——在 GitHub Actions、CircleCI 等中运行 fixtures 的 fork 不会发送事件。

**查看当前状态：** 运行 `archon telemetry status` 可查看遥测是否启用、未启用的原因（若有）、安装 UUID 与活动主机。运行 `archon telemetry reset` 可轮换安装 UUID。`archon doctor` 也会在其检查列表中呈现当前状态。

关闭会给待发送的遥测一个 75 ms 的刷新窗口，随后取消未完成的请求。缓慢或不可达的接收会丢失事件；它不会阻碍命令退出。当离接收主机较远时（例如从欧洲到默认的美国主机约 250 ms 的 TLS 握手），来自 `--help` 这类短命令的事件通常会被丢弃；较长的命令会在运行期间在后台刷新。

通过设置 `POSTHOG_API_KEY` 与 `POSTHOG_HOST` 来自托管 PostHog 或使用不同的项目。

## 贡献

欢迎贡献！可从事的事项见公开的 [issues](https://github.com/coleam00/Archon/issues)。

在提交 pull request 之前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Star 趋势

[![Star History Chart](https://api.star-history.com/chart?repos=coleam00/Archon&type=date&legend=top-left)](https://www.star-history.com/?repos=coleam00%2FArchon&type=date&legend=top-left)

## 许可证

[MIT](LICENSE)
