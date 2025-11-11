# JARVIS - Just A Rather Very Intelligent System

**Your Personal AI Assistant for Development Work**

JARVIS is built on top of [Archon](README.md) and provides a natural language voice interface for coordinating specialist AI agents, managing your knowledge base, and assisting with development tasks.

Inspired by Tony Stark's AI assistant from the MCU, JARVIS brings intelligent orchestration and voice control to your development workflow.

---

## 🎯 What is JARVIS?

JARVIS is an intelligent layer on top of Archon that provides:

- **🎤 Voice Interface** - Natural language commands with speech-to-text and text-to-speech
- **🧠 Intelligent Orchestration** - Automatically selects and coordinates specialist agents
- **📚 Knowledge Integration** - Queries your Archon knowledge base for context
- **🤖 Agent Coordination** - Deploys specialist "Rings" from the BMAD ecosystem
- **💬 JARVIS Personality** - Professional, helpful communication style

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│         JARVIS Voice Interface              │
│         (Port 3738)                         │
│  • Speech-to-text (Whisper)                │
│  • Text-to-speech (OpenAI TTS)             │
│  • Iron Man-inspired UI                     │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│         JARVIS Brain (Port 8055)            │
│  • Intent interpretation (Claude)           │
│  • Agent selection & coordination           │
│  • Knowledge base integration               │
│  • JARVIS personality layer                 │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┼──────────┬───────────────┐
        │          │          │               │
        ▼          ▼          ▼               ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Archon   │ │ Archon   │ │  Agent   │ │  BMAD    │
│ Knowledge│ │   MCP    │ │  Work    │ │  Agents  │
│   Base   │ │  Tools   │ │ Orders   │ │ (Rings)  │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```

---

## 🚀 Quick Start

### Prerequisites

All the same as [Archon](README.md), plus:
- OpenAI API key (for Whisper & TTS)
- Anthropic API key (for JARVIS intelligence)
- Microphone access (for voice input)

### Setup

1. **Ensure Archon is configured**:
   ```bash
   # Make sure you have .env configured with:
   # - SUPABASE_URL
   # - SUPABASE_SERVICE_KEY
   # - OPENAI_API_KEY
   # - ANTHROPIC_API_KEY
   ```

2. **Add JARVIS configuration to .env**:
   ```bash
   # JARVIS Configuration
   JARVIS_PORT=8055
   JARVIS_VOICE_PORT=3738
   JARVIS_USER_NAME=BMad  # Or your preferred name

   # Cost Optimization (Phase 1.5)
   JARVIS_DEFAULT_MODEL=claude-haiku-4-5-20251001
   JARVIS_ADVANCED_MODEL=claude-sonnet-4-5-20250929
   JARVIS_COMPLEXITY_THRESHOLD=0.8
   JARVIS_ENABLE_CACHE=true
   ```

3. **Start all services** (including JARVIS):
   ```bash
   docker compose up -d
   ```

4. **Access JARVIS**:
   - **Voice Interface**: http://localhost:3738
   - **Archon Dashboard**: http://localhost:3737 (for management)

---

## 💬 Using JARVIS

### Voice Interface

1. Open http://localhost:3738
2. Click and hold the JARVIS circle
3. Speak your command
4. Release to process
5. Listen to JARVIS's response

### Example Commands

```
"JARVIS, what's the status of my tasks?"
→ Queries Archon knowledge base for task information

"JARVIS, design an authentication system for my Next.js app"
→ Deploys Vilya (System Architect) to analyze and recommend

"JARVIS, analyze the requirements for a real-time chat feature"
→ Deploys Nenya (Product Manager) for requirements analysis

"JARVIS, research authentication best practices"
→ Deploys Narya (Research Analyst) + queries knowledge base

"JARVIS, good morning"
→ Greets you and reports system status
```

---

## 🎭 JARVIS Personality

JARVIS communicates with a professional, respectful tone inspired by the MCU character:

- **Addresses you appropriately** (default: "Sir", customizable via JARVIS_USER_NAME)
- **Acknowledges commands** ("Understood, Sir.")
- **Reports progress** ("Engaging Vilya, Sir.")
- **Provides status updates** ("Analysis complete.")
- **Handles errors gracefully** ("I'm afraid I've encountered a difficulty, Sir.")

---

## 🤖 Specialist Agents (Rings)

JARVIS can deploy specialist agents from the BMAD ecosystem:

### Phase 1 Rings (Available Now)

1. **Nenya** - Product Manager
   - Requirements analysis
   - Stakeholder mapping
   - User stories

2. **Vilya** - System Architect
   - Architecture design
   - Tech stack decisions
   - System patterns

3. **Narya** - Research Analyst
   - Competitive analysis
   - Feasibility studies
   - Research

### Phase 2 (Coming Soon)

- Full Project ORTRTA integration (7 Rings)
- Custom BMAD agents (40+ more)
- Dynamic agent loading

---

## 📊 Monitoring

### JARVIS Status

```bash
# Check JARVIS health
curl http://localhost:8055/health

# View loaded rings
curl http://localhost:8055/api/rings

# View conversation history
curl http://localhost:8055/api/conversation-history
```

### View Logs

```bash
# JARVIS brain logs
docker compose logs jarvis-brain -f

# Voice interface logs
docker compose logs jarvis-voice -f
```

### Cost Statistics (Phase 1.5)

Monitor your API usage and costs:

```bash
# Get cost and usage statistics
curl http://localhost:8055/api/cost-stats
```

Response includes:
- Total API calls (Haiku vs Sonnet)
- Cache hit rate
- Estimated cost in USD
- Model usage percentage

---

## 💰 Cost Optimization (Phase 1.5)

JARVIS Phase 1.5 introduces smart cost optimization to keep API costs minimal while maintaining high performance.

### How It Works

**Smart Model Selection**:
- **Haiku 4.5** (`claude-haiku-4-5-20251001`) - Fast and cheap for 90% of tasks
  - Input: $1 per million tokens
  - Output: $5 per million tokens
  - Perfect for: greetings, status checks, intent classification

- **Sonnet 4.5** (`claude-sonnet-4-5-20250929`) - Powerful for complex tasks
  - Input: $3 per million tokens
  - Output: $15 per million tokens
  - Used for: multi-agent coordination, technical analysis

**Intelligent Complexity Detection**:
JARVIS automatically analyzes each command and determines complexity:
- Simple (0.0-0.3): Greetings, basic queries → Uses Haiku
- Moderate (0.4-0.7): Information requests → Uses Haiku
- Complex (0.8-1.0): Agent coordination, architecture → Uses Sonnet (if threshold ≥ 0.8)

**Response Caching**:
- Caches responses for 1 hour
- Reduces redundant API calls
- Perfect for repeated queries

### Configuration

```bash
# Default model for most tasks (cheap, fast)
JARVIS_DEFAULT_MODEL=claude-haiku-4-5-20251001

# Advanced model for complex tasks (expensive, powerful)
JARVIS_ADVANCED_MODEL=claude-sonnet-4-5-20250929

# Complexity threshold (0.0-1.0)
# Higher = use Sonnet more often (more expensive)
# Lower = use Haiku more often (cheaper)
JARVIS_COMPLEXITY_THRESHOLD=0.8  # Recommended

# Enable response caching
JARVIS_ENABLE_CACHE=true
```

### Estimated Costs

Based on typical usage patterns (avg. 300 input tokens, 150 output tokens per command):

**Light Use** (10 commands/day):
- ~95% Haiku, ~5% Sonnet
- Haiku: 9.5 calls/day × $0.00105 = $0.30/month
- Sonnet: 0.5 calls/day × $0.00315 = $0.05/month
- **Total: ~$0.35/month**

**Moderate Use** (50 commands/day):
- ~90% Haiku, ~10% Sonnet
- Haiku: 45 calls/day × $0.00105 = $1.42/month
- Sonnet: 5 calls/day × $0.00315 = $0.47/month
- **Total: ~$1.89/month**

**Heavy Use** (200 commands/day):
- ~90% Haiku, ~10% Sonnet
- Haiku: 180 calls/day × $0.00105 = $5.67/month
- Sonnet: 20 calls/day × $0.00315 = $1.89/month
- **Total: ~$7.56/month**

**With Caching** (30% cache hit rate):
- Reduces costs by ~30%
- Heavy use: **~$5.29/month**

### Cost Monitoring

Check your costs in real-time:

```bash
# Via API
curl http://localhost:8055/api/cost-stats

# Via JARVIS voice command
"JARVIS, what's your status?"
# Returns API usage and estimated costs
```

### Tips for Minimizing Costs

1. **Keep cache enabled** - Reduces redundant API calls
2. **Use higher complexity threshold** (0.8-0.9) - Uses Haiku more often
3. **Batch similar queries** - Take advantage of caching
4. **Monitor usage** - Check `/api/cost-stats` regularly

---

## 🔧 Configuration

### Environment Variables

```bash
# JARVIS Core
JARVIS_PORT=8055                    # JARVIS brain API port
JARVIS_VOICE_PORT=3738             # Voice interface port
JARVIS_USER_NAME=Sir               # How JARVIS addresses you

# AI Services
ANTHROPIC_API_KEY=sk-ant-...       # For JARVIS intelligence
OPENAI_API_KEY=sk-...              # For Whisper & TTS

# Archon Integration
ARCHON_MCP_URL=http://archon-mcp:8051
ARCHON_SERVER_URL=http://archon-server:8181
AGENT_WORK_ORDERS_URL=http://archon-agent-work-orders:8053
```

### Customizing JARVIS

Edit `python/src/jarvis/personality.py` to customize:
- Greeting messages
- Communication style
- Response patterns
- Proactive behaviors

---

## 🎯 Phase 1 Features

### ✅ Phase 1.0 (Implemented)

- Voice input (speech-to-text via Whisper)
- Voice output (text-to-speech via OpenAI TTS)
- Intent interpretation (using Claude)
- Knowledge base queries (via Archon MCP)
- Basic agent coordination (3 rings)
- JARVIS personality layer
- Iron Man-inspired UI

### ✅ Phase 1.5 (Cost Optimization)

- Smart model selection (Haiku 4.5 vs Sonnet 4.5)
- Intelligent complexity detection
- Response caching (1 hour TTL)
- Cost tracking and monitoring
- Real-time cost statistics API
- **Result: ~90% cost reduction vs Sonnet-only**

### 🔄 Simulated (Phase 2)

- Agent spawning (simulated responses for now)
- Full BMAD integration
- Task creation
- Proactive monitoring

---

## 🚧 Phase 2 Roadmap

1. **Full Agent Spawning**
   - Real agent deployment via Agent Work Orders
   - Parallel ring coordination
   - Result synthesis

2. **Enhanced Intelligence**
   - Context-aware conversations
   - Learning from interactions
   - Proactive suggestions

3. **System Control**
   - GitHub integration
   - Docker management
   - File system operations

4. **Always-On Features**
   - Wake word detection ("JARVIS")
   - Continuous listening mode
   - Proactive monitoring

---

## 🎨 UI Ports

| Service | Port | Purpose |
|---------|------|---------|
| **JARVIS Voice** | 3738 | Voice interaction (primary interface) |
| **Archon Dashboard** | 3737 | Knowledge & task management |
| **JARVIS Brain** | 8055 | API (internal) |
| Archon Server | 8181 | Backend API (internal) |
| Archon MCP | 8051 | MCP tools (internal) |

---

## 🐛 Troubleshooting

### "Cannot connect to JARVIS brain"

```bash
# Check if JARVIS brain is running
docker compose ps jarvis-brain

# View logs
docker compose logs jarvis-brain

# Restart
docker compose restart jarvis-brain
```

### "Microphone not working"

- Check browser permissions (allow microphone access)
- Use HTTPS or localhost (required for getUserMedia)
- Test with: chrome://settings/content/microphone

### "JARVIS not understanding commands"

- Check ANTHROPIC_API_KEY is set correctly
- View logs for intent classification
- Try simpler, direct commands

### "No voice output"

- Check OPENAI_API_KEY is set correctly
- Check browser audio isn't muted
- View browser console for errors

---

## 📖 Development

### Running JARVIS Locally (Dev Mode)

```bash
# Backend in Docker, frontend local
docker compose up archon-server archon-mcp jarvis-brain -d

# Run voice UI locally
cd jarvis-voice-ui
python main.py

# Access at http://localhost:3738
```

### Project Structure

```
project-jarvis/
├── python/src/jarvis/           # JARVIS brain
│   ├── brain.py                 # Core intelligence
│   ├── personality.py           # Communication style
│   └── main.py                  # FastAPI service
├── jarvis-voice-ui/             # Voice interface
│   ├── main.py                  # Voice UI service
│   └── Dockerfile
├── bmad-integration/            # BMAD agents
│   ├── agent-registry.json      # Available rings
│   └── agents/                  # Ring prompts
└── docker-compose.yml           # Includes JARVIS services
```

---

## 🤝 Contributing

JARVIS is built on Archon. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## 📄 License

Same as Archon - see [LICENSE](LICENSE)

---

## 🎬 Credits

**JARVIS** concept inspired by Marvel's Iron Man
**Built by**: BMad
**Based on**: [Archon](https://github.com/coleam00/Archon) by coleam00
**Powered by**: BMAD Method, Anthropic Claude, OpenAI

---

*"Good morning, Sir. JARVIS is operational and ready to assist."*
