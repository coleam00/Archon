# Claude API Cost Optimization Guide

## Max Plan vs. API — Quick Reference

| Feature | Max Plan ($100–$200/mo) | API (Pay-per-token) |
|---|---|---|
| **Access** | Chat interface, Claude Code, Cowork | Programmatic / build your own apps |
| **Pricing** | Flat monthly fee | Per million tokens (input + output) |
| **Best for** | Daily interactive use | Custom integrations, automations, bots |
| **Models** | All models included | Choose per request |
| **Usage** | 5x or 20x Pro limits | Unlimited (pay as you go) |

**Bottom line:** If you only use Claude through the chat/app, the Max plan is all you need. The API is a separate developer product for building software on top of Claude.

---

## API Token Pricing (as of early 2026)

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Best For |
|---|---|---|---|
| **Haiku 4.5** | $1 | $5 | Simple tasks, classification, fast responses |
| **Sonnet 4.5** | $3 | $15 | Balanced — most production workloads |
| **Opus 4.6** | $5 | $25 | Complex reasoning, agentic tasks |

> ⚠️ Inputs over 200K tokens are billed at **2x** the base rate for Sonnet and Opus.

---

## 7 Strategies to Minimize API Costs

### 1. Use the Right Model for the Job
- **Haiku** → Quick classifications, extractions, short Q&A
- **Sonnet** → General coding, writing, analysis (best cost/performance)
- **Opus** → Only when you need top-tier reasoning or complex multi-step tasks

### 2. Enable Prompt Caching
If you're sending the same system prompt or context repeatedly, cache it.
- **Write once**, read many times at up to **90% discount**
- Example: Sonnet cached reads = $0.30/MTok vs $3.00/MTok regular

### 3. Use Batch Processing (50% Off)
For non-real-time tasks (document processing, bulk analysis, overnight jobs), use the Batch API for an automatic 50% discount on all tokens.

### 4. Write Concise, Structured Prompts
- Be specific about what you want — vague prompts waste tokens on unwanted output
- Use system prompts to set behavior once, not in every user message
- Ask for concise responses when you don't need long-form answers
- Use structured output (JSON) to avoid parsing bloated text responses

### 5. Stay Under the 200K Token Threshold
- Inputs exceeding 200K tokens trigger premium pricing (2x base rate)
- Break large documents into smaller chunks when possible
- Summarize or extract relevant sections before sending to the API

### 6. Limit Output Tokens
- Set `max_tokens` to a reasonable ceiling for your use case
- If you only need a yes/no or a short answer, don't leave room for a 4,000-token essay

### 7. Use Extended Thinking Wisely
- Extended thinking tokens (for complex reasoning) cost the same as output tokens
- Only enable it for tasks that genuinely benefit from step-by-step reasoning
- For simple lookups or classifications, keep it off

---

## Example: Cost-Efficient API Call

```python
import anthropic

client = anthropic.Anthropic()

# Use Haiku for a simple classification task — cheapest option
response = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=100,  # Short response expected
    system="You are a sentiment classifier. Respond with only: positive, negative, or neutral.",
    messages=[
        {"role": "user", "content": "The product arrived on time and works perfectly!"}
    ]
)
print(response.content[0].text)
# Output: "positive"
# Cost: fractions of a cent
```

## Example: When to Use Opus

```python
# Use Opus only for tasks that need deep reasoning
response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=4096,
    system="You are an expert code architect. Analyze the codebase and propose a refactoring plan.",
    messages=[
        {"role": "user", "content": large_codebase_context}
    ]
)
```

---

## Decision Flowchart

```
Is the task simple (classification, short Q&A, extraction)?
  → YES → Use Haiku 4.5

Is the task moderate (coding, writing, analysis)?
  → YES → Use Sonnet 4.5

Does it require deep reasoning, complex planning, or agentic behavior?
  → YES → Use Opus 4.6

Is it a batch/offline job?
  → YES → Use Batch API (50% off any model)

Are you repeating the same context across many calls?
  → YES → Enable Prompt Caching (up to 90% off)
```

---

## Key Takeaways

1. **Max Plan ≠ API** — they're separate products for different use cases
2. **Don't pay for the API if you only chat** — Max covers everything in the interface
3. **Default to Sonnet** — it's the best balance of cost and capability
4. **Cache, batch, and be concise** — these three habits alone can cut costs 50–90%
5. **Set `max_tokens` thoughtfully** — don't leave room for unnecessary output
