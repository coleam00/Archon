# Qwen Setup Guide

Archon provides **first-class support** for Qwen (通义千问) as an AI coding assistant, alongside Claude and Codex. This guide walks you through setup, configuration, and best practices.

## Overview

Qwen is integrated into Archon through the `@qwen-code/sdk`, enabling:

- ✅ Full workflow execution (plan, implement, review, etc.)
- ✅ Streaming responses with thinking blocks
- ✅ Tool use and function calling
- ✅ MCP server integration
- ✅ Title generation
- ✅ Worktree isolation
- ✅ Session resume capability

## Prerequisites

1. **Qwen Code CLI** - Install from [Qwen Code](https://github.com/QwenLM/qwen-code)
2. **Qwen Account** - Sign up at [DashScope](https://dashscope.console.aliyun.com/) or [Bailian](https://bailian.console.aliyun.com/)
3. **Archon** - Installed via binary or built from source

## Installation

### Step 1: Install Qwen Code

```bash
# Via npm
npm install -g @qwen-code/sdk

# Or follow installation instructions at:
# https://github.com/QwenLM/qwen-code
```

### Step 2: Authenticate with Qwen

Qwen Code supports multiple authentication methods:

#### Option A: Qwen OAuth (Recommended)

```bash
# Login via browser OAuth
qwen /login
```

This stores credentials in your Qwen configuration directory, which Archon will automatically detect.

#### Option B: DashScope API Key

1. Go to [DashScope Console](https://dashscope.console.aliyun.com/)
2. Create an API key
3. Set the environment variable:

```bash
export DASHSCOPE_API_KEY="your-api-key-here"
```

#### Option C: Bailian Coding Plan API Key

For enterprise users with Bailian coding plans:

```bash
export BAILIAN_CODING_PLAN_API_KEY="your-bailian-api-key"
```

### Step 3: Configure Archon for Qwen

Run the Archon setup wizard:

```bash
archon setup
```

When prompted to select AI assistants:

```
? Which AI assistant(s) will you use?
◯ Claude (Recommended)
◯ Codex
● Qwen  ← Select this
```

The setup wizard will:
- Detect your existing Qwen authentication
- Register Qwen as an available assistant
- Allow you to set it as the default assistant

## Configuration

### Basic Configuration

Archon stores Qwen configuration in `~/.archon/config.yaml`:

```yaml
assistants:
  qwen:
    model: qwen-max  # Default model to use
    permissionMode: yolo  # or 'plan' for approval-required
    includePartialMessages: true  # Stream partial responses
```

### Advanced Configuration

#### Custom Qwen Executable Path

If you have a specific Qwen binary:

```yaml
assistants:
  qwen:
    pathToQwenExecutable: /opt/qwen-custom/qwen
    model: qwen-max
```

#### Authentication Type Override

By default, Archon follows your existing Qwen Code authentication. To explicitly set auth type:

```yaml
assistants:
  qwen:
    authType: qwen-oauth  # or 'dashscope-api-key', 'bailian-api-key'
    model: qwen-coder
```

#### Per-Workflow Model Selection

You can override the model per workflow node in your `.archon/workflows/*.yaml`:

```yaml
nodes:
  - id: plan
    prompt: "Create implementation plan"
    model: qwen-max  # Use Qwen Max for planning

  - id: implement
    depends_on: [plan]
    prompt: "Implement the plan"
    model: qwen-coder  # Use Qwen Coder for coding
```

## Supported Qwen Models

Archon recognizes and auto-detects the following Qwen model patterns:

### Official Qwen Models

| Model Name | Description | Auto-Detected |
|------------|-------------|---------------|
| `qwen-max` | Most capable Qwen model | ✅ Yes |
| `qwen-coder` | Code-specialized model | ✅ Yes |
| `qwen-turbo` | Fast, cost-effective model | ✅ Yes |
| `qwen-plus` | Balanced performance model | ✅ Yes |
| `qwen-long` | Long context window model | ✅ Yes |
| `qwq-plus` | QwQ reasoning model | ✅ Yes |
| `qwq-max` | QwQ advanced reasoning | ✅ Yes |
| `qvq-72b` | QvQ vision-language model | ✅ Yes |

### Model Name Patterns

The following patterns are automatically recognized as Qwen models:

- Any model starting with `qwen-` (e.g., `qwen-custom-v1`)
- Any model starting with `qwq-` (e.g., `qwq-32b`)
- Any model starting with `qvq-` (e.g., `qvq-72b-preview`)
- Models containing `qwen-coder`, `qwen-max`, `qwen-turbo`, or `qwen-plus`

## Using Qwen with Archon

### Setting Qwen as Default Assistant

```yaml
# In ~/.archon/config.yaml
assistant: qwen
```

Or via environment variable:

```bash
export DEFAULT_AI_ASSISTANT=qwen
```

### Running Workflows with Qwen

Once configured, use Qwen just like any other assistant:

```bash
# From CLI
archon run --assistant qwen --workflow implement-feature

# From Claude Code
Use archon to fix issue #42
# (Archon will use Qwen if it's set as default)
```

### Checking Provider Detection

Archon automatically infers the provider from model names:

```typescript
// These all infer 'qwen' provider:
inferProviderFromModel('qwen-coder')  // → 'qwen'
inferProviderFromModel('qwen-max')    // → 'qwen'
inferProviderFromModel('qwq-plus')    // → 'qwen'
```

## Features & Limitations

### ✅ Fully Supported

- All workflow node types (plan, implement, review, etc.)
- Streaming responses
- Tool use and MCP servers
- Session resume
- Title generation
- Worktree isolation
- Thinking/reasoning blocks
- Error handling with retries

### ⚠️ Not Applicable (Claude-Only Features)

The following workflow features are Claude-specific and don't apply to Qwen:

- `settingSources` - Claude skill/reference sources
- `effort` - Claude effort level control
- `thinking` - Claude thinking toggle
- `maxBudgetUsd` - Claude budget control
- `fallbackModel` - Claude fallback model
- `betas` - Claude beta features
- `sandbox` - Claude sandbox mode
- `hooks` - Claude lifecycle hooks
- `skills` - Claude skill system

### 📝 Current Limitations

- **Structured Output**: `output_format` is not currently forwarded to Qwen workflow nodes (planned for future release)
- **Credential Provisioning**: Archon does not provision Qwen credentials; you must authenticate separately
- **Model Availability**: Not all Qwen models may be available for your account tier

## Troubleshooting

### Error: "Unknown assistant type: qwen"

**Cause**: You're using an outdated Archon binary (pre-v0.3.5).

**Solution**: 
- Build from source: `git clone https://github.com/coleam00/Archon && cd Archon && bun run build`
- Or update to the latest release when available

### Error: "Model not available for your Qwen account"

**Cause**: The configured model isn't accessible with your current Qwen subscription.

**Solution**:
1. Check available models in your DashScope/Bailian console
2. Update your config: `~/.archon/config.yaml`
3. Change `assistants.qwen.model` to an available model (e.g., `qwen-turbo`)

### Qwen CLI Not Found

**Warning**: "Qwen CLI Not Found" during setup

**Solution**: This is usually safe to ignore. Qwen Code SDK can use its bundled CLI by default. Only set `pathToQwenExecutable` if you need a specific binary.

### Authentication Issues

**Symptoms**: Auth errors during workflow execution

**Solutions**:
1. Verify Qwen authentication: `qwen /login` or check API key
2. Check environment variables are set correctly
3. Ensure `authType` matches your authentication method

## Configuration Examples

### Example 1: Minimal Qwen Setup

```yaml
# ~/.archon/config.yaml
assistant: qwen
assistants:
  qwen:
    model: qwen-coder
```

### Example 2: Multi-Assistant with Qwen Default

```yaml
assistant: qwen
assistants:
  claude:
    model: claude-sonnet-4-5-20250929
  qwen:
    model: qwen-max
    permissionMode: yolo
```

### Example 3: Workflow with Mixed Providers

```yaml
# .archon/workflows/feature.yaml
nodes:
  - id: plan
    prompt: "Create detailed implementation plan"
    model: qwen-max  # Use Qwen for planning

  - id: implement
    depends_on: [plan]
    loop:
      prompt: "Implement plan tasks"
      until: ALL_TASKS_COMPLETE
    model: qwen-coder  # Use Qwen Coder for implementation

  - id: review
    depends_on: [implement]
    prompt: "Review implementation against plan"
    model: claude-sonnet-4-5-20250929  # Use Claude for review
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DASHSCOPE_API_KEY` | DashScope API key | If using API key auth |
| `BAILIAN_CODING_PLAN_API_KEY` | Bailian coding plan API key | If using Bailian auth |
| `DEFAULT_AI_ASSISTANT` | Set default assistant to 'qwen' | Optional |
| `TITLE_GENERATION_MODEL` | Override model for title generation | Optional |

## Migration from Binary v0.3.5

If you're upgrading from binary v0.3.5 which had incomplete Qwen support:

1. **Update Archon**: Build from source or wait for next binary release
2. **Verify Configuration**: Run `archon setup` to ensure Qwen is properly registered
3. **Test Workflows**: Run a simple workflow to verify Qwen provider resolution
4. **Check Model Names**: Ensure your configured model is recognized (use `qwen-max`, `qwen-coder`, etc.)

## Additional Resources

- [Qwen Code Repository](https://github.com/QwenLM/qwen-code)
- [DashScope Console](https://dashscope.console.aliyun.com/)
- [Archon Configuration Reference](https://archon.diy/reference/configuration/)
- [Archon AI Assistants Guide](https://archon.diy/getting-started/ai-assistants/)

## Contributing

Found a bug or want to improve Qwen support? Contributions welcome! See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
